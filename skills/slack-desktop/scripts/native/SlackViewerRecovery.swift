import AppKit
import ApplicationServices

struct ViewerVerificationFailure: Error, CustomStringConvertible {
  let description: String
  let diagnostic: [String: Any]
}

// Evidence from the rejecting capture, never from a later cleanup observation.
// Only structural fields and comparisons leave this function; no private URLs or labels.
func viewerFailureDiagnostic(
  content: [String: Any], sourceURL: String, contextId: String?, phase: String,
  reason: String, capturedAt: Int64
) -> [String: Any] {
  let rows = content["nodes"] as? [[String: Any]] ?? []
  let images = rows.filter {
    ($0["classes"] as? [String] ?? []).contains("p-image_viewer__image")
  }
  let expected = viewerImageIdentity(sourceURL, contextId: contextId)
  let evidence: [[String: Any]] = images.prefix(6).map { row in
    let url = row["url"] as? String
    let observed = url.flatMap { viewerImageIdentity($0, contextId: contextId) }
    let role = row["role"] as? String
    return [
      "index": row["index"] as? Int as Any? ?? NSNull(),
      "parent": row["parent"] as? Int as Any? ?? NSNull(),
      "role": role.flatMap { ["AXImage", "AXGroup"].contains($0) ? $0 : nil } as Any? ?? NSNull(),
      "classes": ["p-image_viewer__image"],
      "urlPresent": url != nil,
      "urlMatchesSource": url.map { $0.utf8.elementsEqual(sourceURL.utf8) } as Any? ?? NSNull(),
      "fileMatchesSource": expected.flatMap { e in observed.map { $0.fileId == e.fileId } } as Any?
        ?? NSNull(),
      "ownerMatchesSource": expected.flatMap { e in observed.map { $0.ownerTeamId == e.ownerTeamId }
      } as Any? ?? NSNull(),
    ]
  }
  return [
    "phase": phase, "reason": reason, "capturedAt": capturedAt,
    "captureComplete": content["truncated"] as? Bool == false,
    "sourceVerifiedAtCaptureStart": true, "windowVerifiedAtCaptureStart": true,
    "activeImageCount": images.count, "images": evidence,
    "omittedImages": max(0, images.count - evidence.count),
  ]
}

// A file-details failure reports only fixed structural vocabulary and exact
// comparisons. The rejected pane is evidence, never a source of new authority.
func fileDetailsFailureDiagnostic(
  content: [String: Any], fileId: String, sourceFilePageURL: String?,
  expectedDownloadURL: String? = nil, contextId: String?, mediaKind: String,
  phase: String, reason: String, capturedAt: Int64,
  sourceVerifiedAtCaptureStart: Bool = true, sourceSignatureMatched: Bool? = nil
) -> [String: Any] {
  let rows = content["nodes"] as? [[String: Any]] ?? []
  let knownClasses: Set<String> = [
    "p-view_contents", "p-view_contents--secondary", "p-flexpane_header",
    "p-flexpane_header__control", "p-flexpane__body", "p-file_details__references_footer",
    "c-file__actions", "p-file_details__references_actions", "c-pillow_file_container",
    "p-message_file", "p-message_file--audio_message", "p-search_file--audio-player",
    "p-video_message_file", "p-video_message_file--gallery_v3", "p-file_link_button--link",
    "sr-only", "c-audio_player_play_button",
  ]
  func structure(_ row: [String: Any]) -> [String: Any] {
    let role = row["role"] as? String
    return [
      "index": row["index"] as? Int as Any? ?? NSNull(),
      "parent": row["parent"] as? Int as Any? ?? NSNull(),
      "role": role.flatMap {
        ["AXGroup", "AXLink", "AXButton", "AXCheckBox", "AXMenuItem", "AXPopUpButton"].contains($0)
          ? $0 : nil
      } as Any? ?? NSNull(),
      "classes": Array(Set(row["classes"] as? [String] ?? []).intersection(knownClasses)).sorted(),
    ]
  }
  func sameFile(_ identities: Set<String>?) -> Any {
    guard let identities, !identities.isEmpty else { return NSNull() }
    return identities == Set([fileId])
  }
  let indexes = rows.compactMap { $0["index"] as? Int }
  var priorIndexes = Set<Int>()
  let indexed =
    indexes.count == rows.count && Set(indexes).count == indexes.count
    && rows.enumerated().allSatisfy { offset, row in
      defer { if let index = row["index"] as? Int { priorIndexes.insert(index) } }
      return offset == 0
        ? row["parent"] is NSNull || row["parent"] == nil
        : (row["parent"] as? Int).map { priorIndexes.contains($0) } == true
    }
  let cards = rows.filter { detailsMediaKind($0) != nil }
  let cardEvidence = cards.prefix(6).map { row -> [String: Any] in
    var result = structure(row)
    result["mediaKind"] = detailsMediaKind(row)!
    result["fileMatchesSource"] = sameFile(
      indexed ? (row["index"] as? Int).flatMap { detailsFileIDs(rows, $0) } : nil)
    return result
  }
  func identityKind(_ row: [String: Any]) -> String? {
    let id = row["id"] as? String ?? ""
    if id.hasPrefix("transcript-description-") { return "audio-description" }
    if id.hasPrefix("caption-description-") { return "video-description" }
    if row["role"] as? String == "AXLink",
      (row["classes"] as? [String] ?? []).contains("p-file_link_button--link")
        || (row["url"] as? String).flatMap({ detailsFilePageID($0, contextId: contextId) }) != nil
    {
      return "file-page"
    }
    return nil
  }
  let identities = rows.filter { identityKind($0) != nil }
  let identityEvidence = identities.prefix(6).map { row -> [String: Any] in
    var result = structure(row)
    let kind = identityKind(row)!
    let url = row["url"] as? String
    let observed: String?
    if kind == "file-page" {
      observed = url.flatMap { detailsFilePageID($0, contextId: contextId) }
    } else {
      let prefix = kind == "audio-description" ? "transcript-description-" : "caption-description-"
      let id = row["id"] as? String ?? ""
      let suffix = String(id.dropFirst(prefix.count))
      observed =
        suffix.range(of: #"\AF[A-Z0-9]+\z"#, options: .regularExpression) != nil
        ? suffix : nil
    }
    result["kind"] = kind
    result["fileMatchesSource"] = observed.map { $0 == fileId } as Any? ?? NSNull()
    result["pageURLPresent"] = kind == "file-page" && url != nil
    result["pageMatchesSource"] =
      kind == "file-page"
      ? sourceFilePageURL.flatMap { expected in url.map { $0.utf8.elementsEqual(expected.utf8) } }
        as Any? ?? NSNull() : NSNull()
    return result
  }
  let downloads = rows.filter {
    ["AXLink", "AXButton", "AXMenuItem", "AXPopUpButton"].contains($0["role"] as? String ?? "")
      && downloadLabel($0["label"] as? String ?? "")
  }
  let downloadEvidence = downloads.prefix(6).map { row -> [String: Any] in
    var result = structure(row)
    let url = row["url"] as? String
    result["urlPresent"] = url != nil
    result["urlAllowed"] = url.map(downloadURLAllowed) as Any? ?? NSNull()
    result["fileMatchesSource"] = sameFile(
      (row["index"] as? Int).flatMap { transcriptVideoFileIds([row], $0) })
    result["urlMatchesExpected"] =
      expectedDownloadURL.flatMap { expected in
        url.map { $0.utf8.elementsEqual(expected.utf8) }
      } as Any? ?? NSNull()
    return result
  }
  // The bounded output inventories do not decide whether an omitted row matches.
  // The normal selector remains the only authority to grant a capability.
  var result: [String: Any] = [
    "family": "file-details",
    "mediaKind": ["file", "audio", "video"].contains(mediaKind)
      ? mediaKind : "unknown",
    "phase": phase, "reason": reason, "capturedAt": capturedAt,
    "captureComplete": content["truncated"] as? Bool == false,
    "sourceVerifiedAtCaptureStart": sourceVerifiedAtCaptureStart,
    "windowVerifiedAtCaptureStart": true,
    "cardCount": cards.count, "cards": cardEvidence,
    "omittedCards": max(0, cards.count - cardEvidence.count),
    "identityCount": identities.count, "identities": identityEvidence,
    "omittedIdentities": max(0, identities.count - identityEvidence.count),
    "downloadControlCount": downloads.count, "downloadControls": downloadEvidence,
    "omittedDownloadControls": max(0, downloads.count - downloadEvidence.count),
  ]
  if let sourceSignatureMatched { result["sourceSignatureMatched"] = sourceSignatureMatched }
  return result
}

func verifyFileDetailsCapture(
  _ capture: FileDetailsDownloadCapture, opener: FileDetailsOpenerCandidate, contextId: String?
) throws {
  guard let content = capture.observation["content"] as? [String: Any],
    content["truncated"] as? Bool == false, let rows = content["nodes"] as? [[String: Any]],
    let source = capture.observation["source"] as? [String: Any],
    let sourceContent = source["content"] as? [String: Any],
    sourceContent["truncated"] as? Bool == false,
    let sourceRows = sourceContent["nodes"] as? [[String: Any]],
    let mediaIndex = source["mediaIndex"] as? Int,
    let controlIndex = source["controlIndex"] as? Int,
    source["filePageIndex"] is NSNull || source["filePageIndex"] is Int,
    let sourcePlayback = source["playback"] as? [[String: Any]],
    let detailsPlayback = capture.observation["detailsPlayback"] as? [String: Any],
    let before = capture.observation["before"] as? [String: Any],
    let after = capture.observation["after"] as? [String: Any],
    let url = before["url"] as? String, let title = before["title"] as? String,
    after["url"] as? String == url, after["title"] as? String == title
  else { throw Failure(description: "File details source, pane or view capture is incomplete") }
  for capturedRows in [rows, sourceRows] {
    var prior = Set<Int>()
    for (offset, row) in capturedRows.enumerated() {
      guard let index = row["index"] as? Int, index >= 0, prior.insert(index).inserted,
        offset == 0
          ? index == 0 && row["parent"] is NSNull
          : (row["parent"] as? Int).map({ $0 != index && prior.contains($0) }) == true
      else {
        throw Failure(description: "File details capture ancestry is incomplete or conflicting")
      }
    }
    try require(!prior.isEmpty, "File details capture has no retained root")
  }
  try require(
    fileDetailsDownloadTarget(
      rows, fileId: opener.target.fileId, sourceFilePageURL: opener.target.filePageURL,
      contextId: contextId) == capture.target,
    "File details source, layout or target indexes changed")
  let sourceTarget = fileDetailsOpenerTargets(sourceRows, contextId: contextId).filter {
    $0.containerIndex == 0 && $0.mediaIndex == mediaIndex && $0.controlIndex == controlIndex
      && $0.filePageIndex == source["filePageIndex"] as? Int
      && $0.openerKind == opener.target.openerKind && $0.fileId == opener.target.fileId
      && $0.filePageURL == opener.target.filePageURL && $0.mediaKind == opener.target.mediaKind
  }
  try require(
    sourceTarget.count == 1
      && (try transcriptSourceSignature(sourceRows, 0, selectedMediaIndex: mediaIndex))
        == opener.signature,
    "File details source identity or normalized message signature changed")
  try require(
    downloadPlaybackIdle(capture.sourcePlayback, required: opener.target.mediaKind != "file")
      && downloadPlaybackIdle(capture.viewerPlayback, required: capture.target.playbackRequired)
      && NSDictionary(dictionary: ["values": sourcePlayback]).isEqual(to: [
        "values": opener.playback
      ])
      && NSDictionary(dictionary: ["values": capture.sourcePlayback]).isEqual(to: [
        "values": sourcePlayback
      ])
      && NSDictionary(dictionary: detailsPlayback).isEqual(to: [
        "source": capture.sourcePlayback, "viewer": capture.viewerPlayback,
      ]), "File details source or viewer playback is unknown, changed or not idle")
}

func verifiedFileDetailsCandidate(
  opener: FileDetailsOpenerCandidate, pane: AXUIElement,
  before: FileDetailsDownloadCapture, after: FileDetailsDownloadCapture, contextId: String?
) throws -> FileDetailsDownloadCandidate {
  try verifyFileDetailsCapture(before, opener: opener, contextId: contextId)
  try verifyFileDetailsCapture(after, opener: opener, contextId: contextId)
  let beforeView = before.observation["before"] as! [String: Any]
  let afterView = after.observation["after"] as! [String: Any]
  try require(
    beforeView["url"] as? String == afterView["url"] as? String
      && beforeView["title"] as? String == afterView["title"] as? String,
    "File details workspace view changed between captures")
  let target = after.target
  func retained(_ index: Int) throws -> AXUIElement {
    guard let element = after.elements[index] else {
      throw Failure(description: "File details capture lost a retained control")
    }
    return element
  }
  let candidate = FileDetailsDownloadCandidate(
    token: UUID().uuidString, opener: opener, pane: pane,
    card: try retained(target.cardIndex), identityElement: try retained(target.identityIndex),
    footer: try retained(target.footerIndex), control: try retained(target.controlIndex),
    close: try retained(target.closeIndex), target: target, viewerPlayback: after.viewerPlayback,
    contextId: contextId)
  try candidate.verify(before)
  try candidate.verify(after)
  return candidate
}

// The callback receives a one-shot Close marker, never a Download capability.
func cleanupOwnedViewerAfterFailure(
  downloadAttempted: Bool, openerAccepted: Bool, closeAttempted: Bool, viewerClosed: Bool,
  verifyAndClose: (_ beforePress: () throws -> Void) throws -> String
) -> [String: Any] {
  var attempted = false
  do {
    try require(!downloadAttempted, "Download may have started; cleanup withheld")
    try require(openerAccepted, "Viewer opener acceptance is unverified; cleanup withheld")
    try require(
      !closeAttempted && !viewerClosed, "Viewer Close already requested; cleanup withheld")
    let sourceCheck = try verifyAndClose {
      try require(!attempted, "Viewer Close cannot be replayed")
      attempted = true
    }
    try require(attempted, "Viewer cleanup did not request a verified Close")
    return ["status": "closed", "closeAttempted": true, "closed": true, "sourceCheck": sourceCheck]
  } catch {
    var result: [String: Any] = [
      "status": attempted ? "unverified" : "withheld",
      "closeAttempted": attempted, "closed": false, "error": String(describing: error),
    ]
    if let failure = error as? ViewerVerificationFailure { result["failure"] = failure.diagnostic }
    return result
  }
}

func verifiedViewerCandidate(
  opener: ViewerOpenerCandidate, viewer: AXUIElement,
  before: ViewerDownloadCapture, after: ViewerDownloadCapture
) throws -> ViewerDownloadCandidate {
  for capture in [before, after] {
    guard let content = capture.observation["content"] as? [String: Any],
      content["truncated"] as? Bool == false,
      let rows = content["nodes"] as? [[String: Any]]
    else { throw Failure(description: "Viewer capture is incomplete; input withheld") }
    try require(
      viewerDownloadTarget(rows, sourceURL: opener.target.sourceURL) == capture.target,
      "Viewer source, layout or target indexes changed; input withheld")
    _ = try capture.sourceSignature()
  }
  let target = after.target
  func retained(_ index: Int) throws -> AXUIElement {
    guard let element = after.elements[index] else {
      throw Failure(description: "Viewer capture lost a retained control")
    }
    return element
  }
  let candidate = ViewerDownloadCandidate(
    token: UUID().uuidString, opener: opener, viewer: viewer,
    branch: try retained(target.branchIndex), media: try retained(target.mediaIndex),
    image: try retained(target.imageIndex), footer: try retained(target.footerIndex),
    control: try retained(target.controlIndex), close: try retained(target.closeIndex),
    closeParent: try retained(target.closeParentIndex), target: target,
    sourceSignature: try after.sourceSignature())
  try candidate.verify(before)
  try candidate.verify(after)
  return candidate
}
