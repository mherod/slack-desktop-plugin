import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SLACK_NATIVE_BUNDLE,
  captureNativeBundle,
  nativeGuardBundle,
  writeNativeSnapshot,
  nativeCompileCommand,
} from './slack-native-build.mjs';

async function run(command, timeout) {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const stop = () => child.kill('SIGKILL');
  process.once('SIGTERM', stop);
  const timer = setTimeout(stop, timeout);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, output, errors]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    return stdout;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
  }
}

const assertions = String.raw`
var count = 0
func check(_ value: Bool, _ message: String) {
  if !value { fatalError(message) }
  count += 1
}
func probeFixture(
  configure: AXError = .success, failedAttribute: String? = nil, result: AXError = .success,
  role: CFTypeRef? = "AXApplication" as CFString, children: CFTypeRef? = [] as CFArray,
  calls: inout [String]
) -> SlackAXProbe {
  readSlackAXProbe(pid: 123, configure: { calls.append("timeout"); return configure }, read: { attribute in
    calls.append(attribute)
    if attribute == failedAttribute { return (result, nil) }
    return (.success, attribute == kAXRoleAttribute ? role : children)
  })
}
do {
  var calls: [String] = []
  let probe = probeFixture(calls: &calls)
  check(probe.accessible && probe.status == "accessible" && probe.exitCode == 0, "successful AX application reads establish effective access")
  check(probe.childCount == 0, "empty children are valid access evidence, not a ready workspace claim")
  check(calls == ["timeout", "AXRole", "AXChildren"], "bounded probe performs each read exactly once")
  check(probe.checkedAttributes == ["AXRole", "AXChildren"] && probe.error == nil, "probe retains checked fields separately from UI identity")
  check(permissionState(true, true, probe) == ("ready", 0), "ready requires actual target access and post-event permission")
  check(permissionState(true, false, probe) == ("inspection-only", 0), "effective read access without post-event permission preserves inspection-only behavior")
  check(permissionState(false, true, probe) == ("permission-required", 3), "missing trust cannot be hidden by an earlier successful read")
}
for (attribute, expectedCalls) in [("AXRole", ["timeout", "AXRole"]), ("AXChildren", ["timeout", "AXRole", "AXChildren"])] {
  for status in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .attributeUnsupported, .noValue] {
    var calls: [String] = []
    let probe = probeFixture(failedAttribute: attribute, result: status, calls: &calls)
    check(!probe.accessible && calls == expectedCalls, "failed target read is not retried and later reads are withheld")
    check(probe.error == status && probe.operation == attribute, "original AX error code and failing attribute survive")
    check(probe.status == (status == .apiDisabled ? "api-disabled" : "unavailable"), "API denial stays distinct from timeout and unsupported data")
    check(permissionState(true, true, probe) == (status == .apiDisabled ? ("permission-required", 3) : ("unavailable", 1)), "trusted flag cannot turn a failed real target read into ready")
    check(permissionState(true, false, probe).0 != "inspection-only", "failed target access cannot be called inspection-only")
    let issue = probe.receipt["error"] as? [String: Any]
    check(issue?["code"] as? Int32 == status.rawValue && issue?["name"] as? String == axErrorName(status), "structured probe error retains exact AX evidence")
  }
}
for status in [AXError.apiDisabled, .cannotComplete] {
  var calls: [String] = []
  let probe = probeFixture(configure: status, calls: &calls)
  check(calls == ["timeout"] && probe.checkedAttributes.isEmpty, "timeout configuration failure prevents all AX attribute reads")
  check(probe.error == status && probe.operation == "messaging-timeout", "configuration failure is not relabeled as target absence")
}
for role in [nil, "AXWindow" as CFTypeRef?, 1 as CFTypeRef?] {
  var calls: [String] = []
  let probe = probeFixture(role: role, calls: &calls)
  check(probe.status == "unavailable" && probe.reason == "unexpected-application-role", "missing or wrong application role withholds access readiness")
  check(calls == ["timeout", "AXRole"] && probe.error == nil, "malformed successful AX data does not invent a transport error")
}
for children in [nil, "not-an-array" as CFTypeRef?, ["not-an-AX-element"] as CFTypeRef?] {
  var calls: [String] = []
  let probe = probeFixture(children: children, calls: &calls)
  check(probe.status == "unavailable" && probe.reason == "invalid-children-array", "malformed children cannot establish access")
}
for status in ["not-running", "ambiguous", "not-checked"] {
  let probe = SlackAXProbe(status: status)
  check(permissionState(true, true, probe) == ("unavailable", 1), "unprobed target is not ready")
  check(permissionState(false, true, probe) == ("permission-required", 3), "missing trust retains permission-required status")
}
do {
  let untrusted = SlackAXProbe(status: "not-checked", reason: "accessibility-trust-missing")
  let disabled = SlackAXProbe(status: "api-disabled", error: .apiDisabled, operation: "AXRole")
  let accessible = SlackAXProbe(status: "accessible", checkedAttributes: ["AXRole", "AXChildren"])
  let cases: [(Bool, Bool, SlackAXProbe, String)] = [
    (false, false, untrusted, "permission-required"),
    (true, true, disabled, "permission-required"),
    (true, false, accessible, "inspection-only"),
  ]
  for (trusted, postEvent, probe, expected) in cases {
    let result = permissionReceipt(trusted, postEvent, probe, executable: "/tmp/example-helper")
    let next = result["next"] as! String
    check(result["status"] as? String == expected, "diagnostic wording preserves native permission classification")
    check(result["permissionScope"] as? String == "current-execution-context", "permission observations identify their actual scope without inferring a sandbox")
    check(result["promptRequested"] as? Bool == false && result["settingsOpenRequested"] as? Bool == false, "a diagnostic receipt never invents a setup request")
    check(next.hasPrefix("Verify the intended execution host and its approved access first."), "recovery verifies the execution context before prescribing OS setup")
    check(next.range(of: "normal approval mechanism")!.lowerBound < next.range(of: "Only if")!.lowerBound, "OS setup remains conditional on approved-context verification")
    check(next.contains("Stop if approval is denied.") && next.contains("Do not bypass a denied resource.") && next.contains("No permission is granted and no command is replayed.") && next.contains("Inspect any earlier action outcome before retrying."), "recovery advice preserves approval and replay boundaries")
    check(next.count < 900, "the complete recovery guidance fits the concise renderer without losing guardrails")
    check((result["note"] as? String)?.contains("cannot distinguish execution restrictions from missing macOS approval") == true, "a failed access check does not claim a machine-wide permission diagnosis")
  }
  let keyboard = permissionReceipt(true, false, accessible, executable: "/tmp/example-helper")["next"] as! String
  check(keyboard.contains("Read-only inspection remains available.") && !keyboard.contains("permissions --request"), "keyboard-only guidance retains read-only access and does not offer the trust-only setup prompt")
  check(disabled.next == permissionRecoveryGuidance(), "API-disabled command failures use the same approved-context recovery as permission inspection")
  check(disabled.message.contains("in this execution context") && disabled.message.contains("No command input was attempted"), "API-disabled details scope the failure while retaining the no-input statement")
  let ready = permissionReceipt(true, true, accessible, executable: "/tmp/example-helper")
  check(ready["status"] as? String == "ready" && ready["permissionScope"] as? String == "current-execution-context", "successful access is also scoped to its actual invocation")
  check((ready["next"] as! String).contains("workspace and source still require verification") && !(ready["next"] as! String).contains("permissions --request"), "ready access does not skip source checks or request setup")
  let requested = permissionReceipt(false, false, untrusted, promptRequested: true, settingsOpenRequested: true, executable: "/tmp/example-helper")
  check(requested["status"] as? String == "permission-required" && requested["promptRequested"] as? Bool == true && requested["settingsOpenRequested"] as? Bool == true, "explicit setup request evidence never promotes denied access to ready")
  check((requested["accessibilityProbe"] as! [String: Any])["reason"] as? String == "accessibility-trust-missing", "execution-context guidance preserves the original unattempted-probe reason")
  let unavailable = permissionReceipt(true, true, SlackAXProbe(status: "not-running"), executable: "/tmp/example-helper")
  check(unavailable["status"] as? String == "unavailable" && unavailable["next"] as? String == "Open Slack, then rerun permissions from the same host.", "a missing target keeps its distinct remedy instead of becoming a permission setup diagnosis")
}
do {
  let reader = UIReader(Date().addingTimeInterval(1))
  reader.failed(.apiDisabled)
  reader.failed(.cannotComplete)
  reader.failed(.apiDisabled)
  check(reader.failedReads == 3 && reader.reasons == ["ax-read-error"], "diagnostic AX error recording preserves failure totals")
  check(reader.axErrors.compactMap { $0["code"] as? Int32 } == [-25211, -25204], "diagnostic codes are stable and sorted")
  check(reader.axErrors.compactMap { $0["count"] as? Int } == [2, 1], "repeated diagnostic errors are counted without UI content")
  check(reader.axErrors.compactMap { $0["name"] as? String } == ["api-disabled", "cannot-complete"], "diagnostic errors preserve distinct causes")
}
do {
  let descriptor = CaptureAXDescriptor([
    "role":"AXGroup", "id":"message-toolbar", "classes":["c-message_actions"],
    "label":"DO-NOT-EXPOSE", "AXValue":"DO-NOT-EXPOSE", "AXHelp":"DO-NOT-EXPOSE",
    "url":"https://DO-NOT-EXPOSE", "children":[["label":"DO-NOT-EXPOSE"]]
  ])
  check(Set(descriptor.receipt.keys) == Set(["role","id","classes"]), "conflict descriptors allow only structural metadata")
  check(descriptor.role == "AXGroup" && descriptor.id == "message-toolbar" && descriptor.classes == ["c-message_actions"], "conflict descriptors retain useful structural identity")
  let encoded = String(decoding: try JSONSerialization.data(withJSONObject: descriptor.receipt), as: UTF8.self)
  check(!encoded.contains("DO-NOT-EXPOSE"), "labels, values, URLs, help and nested content cannot leak through conflict descriptors")
  let bounded = CaptureAXDescriptor(["role":String(repeating:"R",count:65),"id":String(repeating:"I",count:201),"classes":Array(repeating:String(repeating:"C",count:97),count:13)])
  check(bounded.role.count == 64 && bounded.id.count == 200 && bounded.classes.count == 12 && bounded.classes.allSatisfy { $0.count == 96 } && bounded.clipped == ["role","id","classes"], "all descriptor fields and class cardinality are bounded and report clipping")
  let unicode = CaptureAXDescriptor(["id":String(repeating:"🧭",count:201)])
  check(unicode.id.unicodeScalars.count == 200 && unicode.id == String(repeating:"🧭",count:200), "descriptor truncation preserves complete Unicode scalars")
  let malformed = CaptureAXDescriptor(["role":7,"id":false,"classes":["safe",4]])
  check(malformed.role.isEmpty && malformed.id.isEmpty && malformed.classes.isEmpty, "malformed descriptor types cannot serialize arbitrary values")
  let unknown = captureParentMatches(false, first:true, current:true)
  check(unknown.values.allSatisfy { $0 is NSNull } && unknown.count == 3, "unknown AXParent never claims first, current or neither-parent identity")
  for (first,current) in [(false,false),(true,false),(false,true),(true,true)] {
    let known = captureParentMatches(true,first:first,current:current)
    check(known["matchesFirst"] as? Bool == first && known["matchesCurrent"] as? Bool == current && known["matchesNeither"] as? Bool == (!first && !current), "known native parent comparisons retain false separately from unknown")
  }
  let conflict = CaptureAncestryConflict(node:descriptor,firstParentIndex:nil,firstParent:nil,firstParentAncestry:[:],currentParentIndex:4,currentParent:descriptor,currentParentAncestry:[:],actualParent:unknown).receipt
  let firstParent = conflict["firstParent"] as! [String:Any]
  let currentParent = conflict["currentParent"] as! [String:Any]
  check(firstParent["index"] is NSNull && firstParent["node"] is NSNull && currentParent["index"] as? Int == 4 && currentParent["node"] is [String:Any], "capture root has no fabricated parent while row indices remain usable")
  let chainRows: [[String:Any]] = (0..<10).map { index in
    ["role":"AXGroup","id":"owner-\(index)","classes":[],"parent":index == 0 ? NSNull() : index - 1,"label":"DO-NOT-EXPOSE","url":"https://DO-NOT-EXPOSE"]
  }
  let shortChain = captureStoredAncestry(chainRows,from:2)
  check((shortChain["ancestors"] as? [[String:Any]])?.compactMap { $0["index"] as? Int } == [2,1,0] && shortChain["stopReason"] as? String == "root" && shortChain["truncated"] as? Bool == false, "stored ancestor order reaches the captured root without new AX reads")
  let longChain = captureStoredAncestry(chainRows,from:9)
  check((longChain["ancestors"] as? [[String:Any]])?.count == 8 && longChain["stopReason"] as? String == "limit" && longChain["truncated"] as? Bool == true, "stored ancestry stops at eight nodes and explicitly reports truncation")
  check(captureStoredAncestry([["parent":0]],from:0)["stopReason"] as? String == "cycle", "cyclic stored ancestry cannot loop")
  check(captureStoredAncestry(chainRows,from:10)["stopReason"] as? String == "invalid-index", "out-of-range parent does not fabricate an ancestor")
  check(captureStoredAncestry([["parent":"DO-NOT-EXPOSE"]],from:0)["stopReason"] as? String == "invalid-parent", "unknown parent type remains incomplete")
  check((captureStoredAncestry(chainRows,from:nil)["ancestors"] as? [[String:Any]])?.isEmpty == true, "capture root has an empty ancestor chain")
  check(!String(decoding:try JSONSerialization.data(withJSONObject:shortChain),as:UTF8.self).contains("DO-NOT-EXPOSE"), "ancestor diagnostics apply the structural allowlist at every level")
}
for command in ["channels", "dms", "channel", "search", "read-channel", "read-dm", "read-thread", "read-transcript", "save-media"] {
  let arguments = [command, "literal"]
  let normal = try interactionArguments(arguments)
  check(normal.0 == .background && normal.1 == arguments, "default interaction keeps native arguments unchanged")
  let explicit = try interactionArguments(["--interaction=foreground"] + arguments)
  check(explicit.0 == .foreground && explicit.1 == arguments, "foreground prefix selects exactly one supported operation")
}
for arguments in [["inspect"], ["inspect", "--ui"], ["read-media", "FFILE"], ["permissions"], ["permissions", "--request"], ["--help"]] {
  check(try interactionArguments(["--interaction=background"] + arguments).1 == arguments, "read-only command can explicitly retain background mode")
  do { _ = try interactionArguments(["--interaction=foreground"] + arguments); fatalError("foreground read-only operation accepted") }
  catch { check(error is Failure, "read-only commands reject foreground before activation") }
}
for arguments in [["--interaction="], ["--interaction=auto", "search", "x"], ["--interaction=Foreground", "search", "x"], ["--interaction=foreground"], ["--interaction=foreground", "--interaction=background", "search", "x"], ["--interaction=background", "--interaction=foreground", "search", "x"]] {
  do { _ = try interactionArguments(arguments); fatalError("invalid interaction prefix accepted") }
  catch { check(error is Failure, "invalid or duplicate interaction prefix rejects") }
}
for query in ["--interaction=foreground", "--interaction=background", "--interaction=auto"] {
  let literal = try interactionArguments(["search", query])
  check(literal.0 == .background && literal.1 == ["search", query], "flag-like query cannot authorize foreground")
}
func exerciseForeground(
  _ session: ForegroundInteraction, original: pid_t = 11,
  current: @escaping () -> pid_t, verify: () throws -> Void = {},
  interrupted: () -> Bool = { false }, idle: () -> Bool = { true },
  activate: () -> Bool, wait: () -> Void = {}
) throws {
  try session.start(pid: 22, originalForeground: original, verify: verify,
    foreground: current, interrupted: interrupted, physicalInputIdle: idle,
    activate: activate, wait: wait)
}
do {
  let session = ForegroundInteraction()
  var front: pid_t = 11
  var activations = 0, verifies = 0
  try exerciseForeground(session, current: { front }, verify: { verifies += 1 }, activate: {
    activations += 1; front = 22; return true
  })
  check(activations == 1 && verifies == 2, "foreground activation occurs once between pinned identity checks")
  check(session.ready && session.state == "activated" && session.activated && session.activationAccepted == true, "foreground success requires accepted and observed activation")
  check(session.receipt["foregroundBefore"] as? Int32 == 11 && session.receipt["pid"] as? Int32 == 22, "activation receipt preserves actual pre-activation application")
  try session.check(foreground: 22, interrupted: false)
  check(!session.ownershipLost, "verified foreground permits guarded input")
  do { try exerciseForeground(session, current: { front }, activate: { activations += 1; return true }); fatalError("activation replay accepted") }
  catch { check(activations == 1, "second activation attempt cannot replay") }
  do { try session.check(foreground: 33, interrupted: false); fatalError("app switch allowed") }
  catch { check(session.ownershipLost, "observed user app switch revokes foreground ownership") }
  do { try session.check(foreground: 22, interrupted: false); fatalError("ownership reacquired") }
  catch { check(activations == 1, "returning to Slack never silently reacquires foreground ownership") }
}
do {
  let session = ForegroundInteraction()
  var activated = false
  try exerciseForeground(session, original: 22, current: { 22 }, activate: { activated = true; return true })
  check(!activated && !session.activationRequested && !session.activated && session.state == "already-foreground", "already-foreground Slack requires no activation request")
  do { try session.check(foreground: 22, interrupted: true); fatalError("interrupted input allowed") }
  catch { check(session.ownershipLost, "cancellation revokes foreground ownership") }
}
for reason in ["identity", "interrupted", "physical", "changed-foreground", "missing-foreground"] {
  let session = ForegroundInteraction()
  var activations = 0
  do {
    try exerciseForeground(session, original: reason == "missing-foreground" ? 0 : 11,
      current: { reason == "changed-foreground" ? 33 : reason == "missing-foreground" ? 0 : 11 },
      verify: { if reason == "identity" { throw Failure(description: "pinned identity changed") } },
      interrupted: { reason == "interrupted" }, idle: { reason != "physical" },
      activate: { activations += 1; return true })
    fatalError("unsafe activation accepted")
  } catch {
    check(activations == 0 && !session.activationRequested && session.state == "failed", "unsafe preflight withholds activation")
  }
}
for reason in ["refused", "not-observed", "other-app", "cancelled", "identity-after"] {
  let session = ForegroundInteraction()
  var activations = 0, waits = 0, verifies = 0
  var front: pid_t = 11
  do {
    try exerciseForeground(session, current: { front }, verify: {
      verifies += 1
      if reason == "identity-after" && verifies == 2 { throw Failure(description: "workspace changed after activation") }
    }, interrupted: { reason == "cancelled" && activations > 0 }, activate: {
      activations += 1
      if reason == "other-app" { front = 33 }
      if reason == "identity-after" { front = 22 }
      return reason != "refused"
    }, wait: { waits += 1 })
    fatalError("unverified activation accepted")
  } catch {
    check(activations == 1 && session.activationRequested && !session.ready, "failed activation is never replayed or treated as input-ready")
    check(session.activationAccepted == (reason != "refused"), "API acceptance remains distinct from observed foreground")
    check(waits <= 20 && (reason != "not-observed" || waits == 20), "activation observation is bounded")
  }
}
do {
  let session = ForegroundInteraction()
  var front: pid_t = 11
  var waits = 0
  try exerciseForeground(session, current: { front }, activate: { true }, wait: {
    waits += 1
    if waits == 2 { front = 22 }
  })
  check(waits == 2 && session.ready, "one asynchronous activation may settle without another request")
}
for reference in ["FFILE1", "CDEMO:1700000000.000001/m1", "DDEMO:1700000000.000001/m9999", "GDEMO:1700000000.000001/m20"] {
  check(validMediaReference(reference), "valid attachment reference accepted")
}
for reference in ["F" + String(repeating: "A", count: 256), "F", "ffile", "FFILE\n", "FFILE\r", "CDEMO:1700000000.000001/p1", "CDEMO:1700000000.000001/m0", "CDEMO:1700000000.000001/m01", "CDEMO:1700000000.000001/m10000", "CDEMO:1700000000.000001", "https://demo.slack.com/files/USER/FFILE"] {
  check(!validMediaReference(reference), "unsupported media reference rejected before AX work")
}
// Transcript action selection is a one-shot capability, never an arbitrary selector.
for value in ["View transcript", "View transcript for this audio", "View transcript for this video"] {
  check(existingTranscriptLabel(value), "existing transcript labels accepted")
}
for value in ["Generate transcript", "Generate transcript for this audio", "View transcript now", "view transcript", "View transcript\n", "Play"] {
  check(!existingTranscriptLabel(value), "generation and lookalike labels rejected")
}
let tokenData = Data(#"{"token":"observed-token"}"#.utf8)
check(try transcriptSelectionToken(tokenData, ["observed-token"]) == "observed-token", "only offered transcript token is accepted")
for value in [#"{"token":"stale-token"}"#, #"{"token":1}"#, #"{"cancel":true}"#, #"{"token":"observed-token","action":"press"}"#, #"["observed-token"]"#, #"{}"#, "null", "invalid", String(repeating: " ", count: 4097)] {
  do { _ = try transcriptSelectionToken(Data(value.utf8), ["observed-token"]); fatalError("invalid transcript selection accepted") }
  catch { check(true, "invalid transcript selection withheld") }
}
let transcriptRows: [[String: Any]] = [
  ["index": 100, "parent": 99, "role": "AXGroup", "classes": ["c-message_kit__actions"], "label": "source"],
  ["index": 101, "parent": 100, "role": "AXButton", "classes": ["control", "c-button--disabled"], "label": "View transcript"],
  ["index": 102, "parent": 100, "role": "AXGroup", "classes": ["p-media_volume_slider", "p-media_volume_slider--popover"], "label": ""],
  ["index": 103, "parent": 100, "role": "AXStaticText", "classes": [], "label": "stable filename.mp4"]
]
let normalizedTranscriptRows = try transcriptSourceRows(transcriptRows, 100)
check(normalizedTranscriptRows.count == 4, "source subtree retains every row")
check(normalizedTranscriptRows[0]["index"] as? Int == 0 && normalizedTranscriptRows[0]["parent"] is NSNull, "source root ancestry is relative")
check(normalizedTranscriptRows[1]["parent"] as? Int == 0, "source child ancestry is relative")
check(normalizedTranscriptRows[1]["classes"] as? [String] == ["control"], "existing transcript enabled-state class is normalized")
check(normalizedTranscriptRows[2]["classes"] as? [String] == ["p-media_volume_slider"], "volume layout modifier is normalized")
var equivalentTranscriptRows = normalizedTranscriptRows
equivalentTranscriptRows[2]["classes"] = ["p-media_volume_slider", "p-media_volume_slider--vertical"]
check(try transcriptSourceSignature(transcriptRows, 100) == transcriptSourceSignature(equivalentTranscriptRows, 0), "benign index and transcript layout changes preserve source identity")
var changedTranscriptRows = transcriptRows
changedTranscriptRows[3]["label"] = "replacement filename.mp4"
check(try transcriptSourceSignature(transcriptRows, 100) != transcriptSourceSignature(changedTranscriptRows, 100), "changed media metadata invalidates source binding")
changedTranscriptRows = transcriptRows
changedTranscriptRows.swapAt(1, 2)
check(try transcriptSourceSignature(transcriptRows, 100) != transcriptSourceSignature(changedTranscriptRows, 100), "changed media child order invalidates source binding")
func searchCardFixture(_ clipped:Bool,_ videos:Int = 1) -> [[String:Any]] {
  var rows:[[String:Any]] = []
  @discardableResult func node(_ parent:Int?,_ role:String,_ names:[String],_ text:String = "") -> Int {
    let index = rows.count
    var row:[String:Any] = ["index":index,"parent":parent as Any? ?? NSNull(),"role":role,"classes":names,"id":"","label":text,"AXTitle":text,"AXDescription":"","AXValue":"","AXHelp":""]
    if role == "AXButton" || role == "AXCheckBox" { row["selected"] = false; row["stateValue"] = role == "AXCheckBox" ? "0" : "" }
    rows.append(row); return index
  }
  node(nil,"AXGroup",["c-message_kit__actions","c-message_kit__actions--above","c-search_message__actions_container--ia4"])
  node(0,"AXGroup",["c-search_message__gutter"])
  let header = node(0,"AXGroup",["c-search_message__content_header","c-search_message__content_header--compact"])
  node(header,"AXStaticText",[],"Synthetic author")
  let owner = clipped ? node(0,"AXGroup",["c-search_message__body--card_clamp","c-search_message__body--card_clipped"]) : 0
  let rich = node(owner,"AXGroup",["p-rich_text_section"])
  node(rich,"AXStaticText",[],"Preserved message text")
  node(rich,"AXButton",["c-button-unstyled","c-search__expand"],"Nested expand one")
  node(rich,"AXButton",["c-button-unstyled","c-search__expand"],"Nested expand two")
  let link = node(rich,"AXLink",[],"Body link"); rows[link]["url"] = "https://example.test/body"
  if clipped { node(0,"AXButton",["c-button-unstyled","c-search__expand"],"... Show more") }
  for video in 0..<videos {
    let media = node(0,"AXGroup",["p-video_message_file","p-video_message_file--gallery_v3","c-search_message__media_item"])
    let file = node(media,"AXLink",[],"Synthetic video")
    rows[file]["url"] = video == 0 ? "https://files.slack.com/files-pri/TDEMO-FDEMO/demo.mp4" : "https://files.slack.com/files-pri/TDEMO-FDEMO\(video)/demo.mp4"
    node(media,"AXCheckBox",[],"Play, \(5+video) seconds")
    node(media,"AXButton",["c-icon_button"],"View transcript")
  }
  return rows
}
let searchCardBefore = searchCardFixture(false), searchCardAfter = searchCardFixture(true)
func cardIndex(_ rows:[[String:Any]],_ css:String) -> Int { rows.first { ($0["classes"] as? [String] ?? []).contains(css) }!["index"] as! Int }
let cardMedia = cardIndex(searchCardAfter,"p-video_message_file")
let cardSignature = try transcriptSourceSignature(searchCardBefore,0,selectedMediaIndex:cardIndex(searchCardBefore,"p-video_message_file"))
func sameCardSignature(_ rows:[[String:Any]],media:Int? = cardMedia) -> Bool {
  (try? transcriptSourceSignature(rows,0,selectedMediaIndex:media)) == cardSignature
}
check(sameCardSignature(searchCardAfter), "complete observed clamp and adjacent Show more layout preserves the exact source signature")
let observedFocusedExpandClasses=["c-button--focus-visible","c-button-unstyled","c-search__expand"]
var focusedExpandCard=searchCardAfter
let focusedExpandIndex=focusedExpandCard.first {$0["parent"] as? Int == 0 && ($0["classes"] as? [String] ?? []).contains("c-search__expand")}!["index"] as! Int
focusedExpandCard[focusedExpandIndex]["classes"]=observedFocusedExpandClasses
check(sameCardSignature(focusedExpandCard),"the exact observed focused direct Show more variant preserves its complete source")
for names in [Array(observedFocusedExpandClasses.reversed()),["c-button-unstyled","c-button--focus-visible","c-search__expand"],observedFocusedExpandClasses+["unknown"],observedFocusedExpandClasses+["c-button--focus-visible"],["c-button--focus-visible","c-search__expand"],["c-button--focus-visible","c-button-unstyled"]] {
  var rows=focusedExpandCard;rows[focusedExpandIndex]["classes"]=names
  check(!sameCardSignature(rows),"unknown, reordered, duplicated or incomplete focused expander classes cannot normalize")
}
for (field,value) in [("selected",true as Any),("stateValue","1" as Any),("AXHelp","foreign" as Any),("unknown",true as Any)] {
  var rows=focusedExpandCard;rows[focusedExpandIndex][field]=value
  check(!sameCardSignature(rows),"the focused class alternative preserves all original field and state guards")
}
let normalizedCard = try transcriptSourceRows(searchCardAfter,0,selectedMediaIndex:cardMedia)
check(normalizedCard.count == searchCardAfter.count - 2, "only the known wrapper and direct Show more button are omitted")
check(normalizedCard.filter { ($0["classes"] as? [String] ?? []).contains("c-search__expand") }.count == 2, "nested source expand controls remain in the normalized message")
let cardWrapper = cardIndex(searchCardAfter,"c-search_message__body--card_clamp")
let cardButton = searchCardAfter.first { $0["parent"] as? Int == 0 && $0["label"] as? String == "... Show more" }!["index"] as! Int
for (field,value) in [
  ("role","AXButton" as Any),("classes",["c-search_message__body--card_clamp","c-search_message__body--card_clipped","unknown"] as Any),
  ("id","other" as Any),("label","other" as Any),("AXTitle","other" as Any),("AXDescription","other" as Any),("AXValue","other" as Any),("AXHelp","other" as Any),("url","https://example.test/unknown" as Any)
] {
  var changed = searchCardAfter; changed[cardWrapper][field] = value
  check(!sameCardSignature(changed), "nonempty or unknown wrapper metadata remains significant")
}
for (field,value) in [
  ("role","AXGroup" as Any),("classes",["c-button-unstyled","c-search__expand","unknown"] as Any),("id","other" as Any),
  ("label","Show more" as Any),("AXTitle","other" as Any),("AXDescription","other" as Any),("AXValue","other" as Any),("AXHelp","other" as Any),
  ("stateValue","1" as Any),("selected",true as Any),("unknown",true as Any)
] {
  var changed = searchCardAfter; changed[cardButton][field] = value
  check(!sameCardSignature(changed), "only the complete observed direct Show more control can normalize")
}
for index in [0,cardIndex(searchCardAfter,"p-rich_text_section")] {
  var changed = searchCardAfter; changed[index]["unknown"] = true
  check(!sameCardSignature(changed), "unknown root or rich-text wrapper attributes prevent layout normalization")
}
for (index,field) in [(cardWrapper,"AXHelp"),(cardButton,"selected")] {
  var changed = searchCardAfter; changed[index].removeValue(forKey:field)
  check(!sameCardSignature(changed), "missing metadata or unknown selection state cannot complete the known pair")
}
for (index,field,value) in [
  (cardWrapper+2,"label","Changed message" as Any),(cardWrapper+5,"url","https://example.test/changed" as Any),
  (cardMedia+1,"url","https://files.slack.com/files-pri/TDEMO-FOTHER/changed.mp4" as Any),(cardMedia+2,"stateValue","1" as Any),
  (cardWrapper+3,"label","Changed nested expand" as Any),(cardWrapper+4,"AXTitle","Changed nested title" as Any)
] {
  var changed = searchCardAfter; changed[index][field] = value
  check(!sameCardSignature(changed), "normalization never hides changed body links, nested controls, media identity or playback")
}
check(!sameCardSignature(searchCardAfter.filter { $0["index"] as? Int != cardButton }), "a wrapper without its direct Show more pair remains significant")
var reorderedCard = searchCardAfter; reorderedCard.swapAt(cardWrapper,cardButton)
check(!sameCardSignature(reorderedCard), "reordered direct controls do not match the known layout")
var foreignCard = searchCardAfter; foreignCard[cardButton]["parent"] = cardWrapper
check(!sameCardSignature(foreignCard), "nested or foreign Show more cannot authorize normalization")
for index in [cardWrapper,cardButton] {
  var changed = searchCardAfter; var duplicate = changed[index]; duplicate["index"] = 1000; changed.append(duplicate)
  check(!sameCardSignature(changed), "duplicated wrapper or direct Show more is ambiguous")
}
for parent in [cardWrapper,cardButton] {
  var changed = searchCardAfter; var extra = changed[cardWrapper+2]; extra["index"] = 1000; extra["parent"] = parent; changed.append(extra)
  check(!sameCardSignature(changed), "extra wrapper children and nonleaf Show more controls cannot be dropped")
}
check(!sameCardSignature(searchCardAfter,media:nil), "unselected media cannot trigger search-card normalization")
check(!sameCardSignature(searchCardAfter,media:cardMedia+1), "a child of the video cannot substitute for the selected direct video root")
let siblingCardBefore = searchCardFixture(false,3), siblingCardAfter = searchCardFixture(true,3)
func siblingMedia(_ rows:[[String:Any]]) -> [Int] {
  rows.filter { ($0["classes"] as? [String] ?? []).contains("p-video_message_file") }.map {$0["index"] as! Int}
}
let siblingBeforeIndexes=siblingMedia(siblingCardBefore), siblingAfterIndexes=siblingMedia(siblingCardAfter)
let siblingSignature=try transcriptSourceSignature(siblingCardBefore,0,selectedMediaIndex:siblingBeforeIndexes[2])
var focusedSiblingCard=siblingCardAfter
let focusedSiblingExpand=focusedSiblingCard.first {$0["parent"] as? Int == 0 && ($0["classes"] as? [String] ?? []).contains("c-search__expand")}!["index"] as! Int
focusedSiblingCard[focusedSiblingExpand]["classes"]=observedFocusedExpandClasses
check(try transcriptSourceSignature(focusedSiblingCard,0,selectedMediaIndex:siblingAfterIndexes[2]) == siblingSignature,"the exact focused direct expander also binds the selected third video")
var nestedFocusedBefore=siblingCardBefore,nestedFocusedAfter=focusedSiblingCard
for index in nestedFocusedBefore.indices where (nestedFocusedBefore[index]["classes"] as? [String] ?? []).contains("c-search__expand") {nestedFocusedBefore[index]["classes"]=observedFocusedExpandClasses}
for index in nestedFocusedAfter.indices where nestedFocusedAfter[index]["parent"] as? Int != 0 && (nestedFocusedAfter[index]["classes"] as? [String] ?? []).contains("c-search__expand") {nestedFocusedAfter[index]["classes"]=observedFocusedExpandClasses}
let nestedFocusedSignature=try transcriptSourceSignature(nestedFocusedBefore,0,selectedMediaIndex:siblingBeforeIndexes[2])
check(try transcriptSourceSignature(nestedFocusedAfter,0,selectedMediaIndex:siblingAfterIndexes[2]) == nestedFocusedSignature,"unchanged nested focused expanders remain part of the preserved source")
let nestedFocusedIndex=nestedFocusedAfter.first {$0["parent"] as? Int != 0 && ($0["classes"] as? [String] ?? []).contains("c-search__expand")}!["index"] as! Int
nestedFocusedAfter[nestedFocusedIndex]["classes"]=["c-button-unstyled","c-search__expand"]
check(try transcriptSourceSignature(nestedFocusedAfter,0,selectedMediaIndex:siblingAfterIndexes[2]) != nestedFocusedSignature,"focus classes on nested source expanders are never stripped by the direct-pair exception")
for selected in 0..<3 {
  check(try transcriptSourceSignature(siblingCardAfter,0,selectedMediaIndex:siblingAfterIndexes[selected]) == transcriptSourceSignature(siblingCardBefore,0,selectedMediaIndex:siblingBeforeIndexes[selected]),"each selected video inside the uninterrupted known sibling run retains the complete source signature")
}
let siblingNormalized=try transcriptSourceRows(siblingCardAfter,0,selectedMediaIndex:siblingAfterIndexes[2])
check(siblingNormalized.count == siblingCardAfter.count-2 && siblingMedia(siblingNormalized).count == 3,"third-video normalization drops only the pair and preserves all sibling media")
check(siblingNormalized.filter {($0["classes"] as? [String] ?? []).contains("c-search__expand")}.count == 2,"third-video normalization preserves nested rich-text expand controls")
for (role,names) in [("AXStaticText",[String]()),("AXButton",[String]()),("AXGroup",["foreign"]),("AXGroup",["p-video_message_file","unknown"])] {
  var rows=siblingCardAfter
  rows.insert(["index":1000,"parent":0,"role":role,"classes":names],at:siblingAfterIndexes[1])
  check(transcriptSearchCardRows(rows,0,siblingAfterIndexes[2]).count == rows.count,"an intervening foreign or nonmedia direct row terminates the eligible sibling run")
}
for media in [0,siblingAfterIndexes[2]+1,1000] {
  check(transcriptSearchCardRows(siblingCardAfter,0,media).count == siblingCardAfter.count,"missing, foreign and descendant selected identities cannot authorize clipping normalization")
}
for changedSibling in 0..<3 {
  let media=siblingAfterIndexes[changedSibling]
  for (index,field,value) in [(media,"classes",["p-video_message_file","unknown"] as Any),(media+1,"url","https://files.slack.com/files-pri/TDEMO-FOTHER/demo.mp4" as Any),(media+2,"stateValue","1" as Any),(media+2,"label","Play, 99 seconds" as Any)] {
    var rows=siblingCardAfter;rows[index][field]=value
    check(try transcriptSourceSignature(rows,0,selectedMediaIndex:siblingAfterIndexes[2]) != siblingSignature,"every sibling kind, file identity, playback state and duration remains source-bound")
  }
}
for index in [cardWrapper+2,cardWrapper+5] {
  var rows=siblingCardAfter;rows[index][index == cardWrapper+5 ? "url" : "label"]="changed body or link"
  check(try transcriptSourceSignature(rows,0,selectedMediaIndex:siblingAfterIndexes[2]) != siblingSignature,"selecting a later clip cannot hide body or link edits")
}
let removedSibling=siblingCardAfter.filter { !Set(siblingAfterIndexes[1]..<(siblingAfterIndexes[1]+4)).contains($0["index"] as! Int) }
check(try transcriptSourceSignature(removedSibling,0,selectedMediaIndex:siblingAfterIndexes[2]) != siblingSignature,"removing an earlier sibling remains a complete-source change")
let reorderedSiblings=Array(siblingCardAfter.prefix(siblingAfterIndexes[0])) + Array(siblingCardAfter[siblingAfterIndexes[1]..<(siblingAfterIndexes[1]+4)]) + Array(siblingCardAfter[siblingAfterIndexes[0]..<(siblingAfterIndexes[0]+4)]) + Array(siblingCardAfter.suffix(4))
check(try transcriptSourceSignature(reorderedSiblings,0,selectedMediaIndex:siblingAfterIndexes[2]) != siblingSignature,"reordering complete earlier video subtrees remains significant")
var reparentedSibling=siblingCardAfter;reparentedSibling[siblingAfterIndexes[2]]["parent"]=siblingAfterIndexes[1]
check(transcriptSearchCardRows(reparentedSibling,0,siblingAfterIndexes[2]).count == reparentedSibling.count,"a nested sibling cannot pose as a direct source video")
changedTranscriptRows = transcriptRows
changedTranscriptRows[1]["label"] = "Generate transcript"
check((try transcriptSourceRows(changedTranscriptRows, 100))[1]["classes"] as? [String] == ["control", "c-button--disabled"], "generation control classes are never normalized")
changedTranscriptRows = transcriptRows
changedTranscriptRows[2]["classes"] = ["other-control", "p-media_volume_slider--popover"]
check((try transcriptSourceRows(changedTranscriptRows, 100))[2]["classes"] as? [String] == ["other-control", "p-media_volume_slider--popover"], "unrelated controls retain all classes")
do { _ = try transcriptSourceRows(transcriptRows, 999); fatalError("missing source root accepted") }
catch { check(error is Failure, "missing source root stops resolution") }
check(transcriptControlActive(["c-button--disabled"], false), "selected disabled View control binds active transcript panel")
check(!transcriptControlActive([], false), "unmarked control cannot bind transcript")
check(!transcriptControlActive(["c-button--disabled"], true), "enabled control cannot bind active transcript")
check(!transcriptControlActive(["c-button--disabled"], nil), "unknown control state cannot bind transcript")

func transcriptLeaf(_ index: Int, _ parent: Int, _ text: String) -> [String: Any] {
  ["index": index, "parent": parent, "role": "AXStaticText", "classes": [String](), "id": "",
   "label": text, "AXValue": text, "AXTitle": "", "AXDescription": "", "AXHelp": ""]
}
let splitTranscriptLink: [[String: Any]] = [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"]],
  ["index": 1, "parent": 0, "role": "AXLink", "classes": ["c-link"], "url": "https://example.slack.com/files/UDEMO/FDEMO/demo.mp4"],
  transcriptLeaf(2, 1, "demo."), transcriptLeaf(3, 1, "mp4"),
  ["index": 4, "parent": 0, "role": "AXGroup", "classes": ["p-video_controls_overlay"], "label": "demo.\u{E000}mp4\u{E001}", "AXTitle": "demo.\u{E000}mp4\u{E001}", "AXDescription": "demo.\u{E000}mp4\u{E001}"]
]
var joinedTranscriptLink = Array(splitTranscriptLink.prefix(2)) + [transcriptLeaf(2, 1, "demo.mp4"), splitTranscriptLink[4]]
joinedTranscriptLink[3]["index"] = 3
for field in ["label", "AXTitle", "AXDescription"] { joinedTranscriptLink[3][field] = "demo.mp4" }
let splitSignature = try transcriptSourceSignature(splitTranscriptLink, 0)
check(try splitSignature == transcriptSourceSignature(joinedTranscriptLink, 0), "highlighted filename split/merge preserves exact joined link text")
check((try transcriptSourceRows(splitTranscriptLink, 0)).count == 4, "only adjacent anonymous link text leaves coalesce")
var alteredTranscriptLink = joinedTranscriptLink
alteredTranscriptLink[1]["url"] = "https://example.slack.com/files/UDEMO/FOTHER/demo.mp4"
check(try splitSignature != transcriptSourceSignature(alteredTranscriptLink, 0), "different parent link URL remains a different source")
alteredTranscriptLink = joinedTranscriptLink
alteredTranscriptLink[3]["label"] = "replacement.mp4"
check(try splitSignature != transcriptSourceSignature(alteredTranscriptLink, 0), "changed filename is not hidden by highlight normalization")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[2]["id"] = "meaningful-text"
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "identified text nodes are never coalesced")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[3]["AXHelp"] = "meaningful help"
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "help-bearing text nodes are never coalesced")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[3]["classes"] = ["highlight-style"]
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "styled text nodes are never coalesced")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[3]["stateValue"] = "unexpected"
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "unknown attributes prevent coalescing")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[1]["role"] = "AXGroup"
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "non-link text splitting remains structurally significant")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[2]["AXValue"] = "different-value"
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 5, "nonidentical label/value does not coalesce")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink.swapAt(2, 3)
check(try splitSignature != transcriptSourceSignature(alteredTranscriptLink, 0), "reordered text changes the concatenated identity")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink[1]["url"] = "https://example.slack.com/\u{E000}source"
check((try transcriptSourceRows(alteredTranscriptLink, 0))[1]["url"] as? String == "https://example.slack.com/\u{E000}source", "URL identities never lose marker characters")
alteredTranscriptLink = splitTranscriptLink
alteredTranscriptLink.append(transcriptLeaf(5, 2, "nested"))
check((try transcriptSourceRows(alteredTranscriptLink, 0)).count == 6, "text with children cannot be treated as an anonymous leaf")

let closedAudioSource: [[String: Any]] = [
  ["index": 100, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"]],
  ["index": 101, "parent": 100, "role": "AXGroup", "classes": ["p-search_file--audio-player"]],
  ["index": 102, "parent": 101, "role": "AXGroup", "classes": [String]()],
  ["index": 103, "parent": 102, "role": "AXGroup", "classes": ["sr-only"], "id": "transcript-description-FAUDIO"],
  ["index": 104, "parent": 102, "role": "AXButton", "classes": ["c-icon_button"], "label": "View transcript"],
  ["index": 105, "parent": 101, "role": "AXLink", "classes": ["c-link"], "url": "https://files.slack.com/files-pri/TDEMO-FAUDIO/audio.m4a"],
  ["index": 106, "parent": 100, "role": "AXGroup", "classes": ["p-search_file--audio-player"]],
  ["index": 107, "parent": 106, "role": "AXGroup", "classes": [String]()],
  ["index": 108, "parent": 107, "role": "AXButton", "classes": ["c-icon_button"], "label": "View transcript"]
]
var openAudioSource = closedAudioSource
openAudioSource[2]["classes"] = ["active"]
openAudioSource.insert(contentsOf: [
  ["index": 130, "parent": 102, "role": "AXGroup", "classes": ["ReactModal__Content", "ReactModal__Content--after-open", "popover", "c-popover__content"]],
  ["index": 131, "parent": 130, "role": "AXGroup", "classes": ["p-media_transcript", "p-media_transcript--popover"]],
  ["index": 132, "parent": 131, "role": "AXButton", "classes": ["p-media_transcript__text"], "label": "Synthetic transcript segment"]
], at: 5)
let audioBinding = audioTranscriptBindingRows(openAudioSource, 101, controlIndex: 104, panelIndex: 131)
check(audioBinding?["wrapperIndex"] == 102 && audioBinding?["popoverIndex"] == 130, "audio transcript binds exact direct player/opener/panel ancestry")
check(audioTranscriptBindingRows(closedAudioSource, 101) == nil, "closed audio source has no active transcript binding")
check(audioTranscriptBindingRows(openAudioSource, 106) == nil, "another audio player cannot claim this transcript")
check(audioTranscriptBindingRows(openAudioSource, 101, controlIndex: 108) == nil, "another opener cannot claim the selected audio transcript")
check(audioTranscriptBindingRows(openAudioSource, 101, panelIndex: 999) == nil, "unobserved panel cannot claim the audio source")
let closedAudioSignature = try transcriptSourceSignature(closedAudioSource, 100, selectedMediaIndex: 101)
check(try closedAudioSignature == transcriptSourceSignature(openAudioSource, 100, selectedMediaIndex: 101), "only selected audio transcript popover and its active wrapper are normalized")
check(try transcriptSourceSignature(closedAudioSource, 100) != transcriptSourceSignature(openAudioSource, 100), "unselected transcript popovers remain significant")
check(try transcriptSourceSignature(closedAudioSource, 100, selectedMediaIndex: 106) != transcriptSourceSignature(openAudioSource, 100, selectedMediaIndex: 106), "another player's transcript is not normalized")
var changedAudioSource = openAudioSource
changedAudioSource[1]["classes"] = ["p-video_message_file"]
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "video player cannot use audio ownership proof")
changedAudioSource = openAudioSource
changedAudioSource[2]["classes"] = ["active", "unrecognized"]
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "unknown active wrapper shape is rejected")
changedAudioSource = openAudioSource
changedAudioSource[5]["parent"] = 101
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "popover outside opener wrapper is rejected")
changedAudioSource = openAudioSource
changedAudioSource[6]["parent"] = 102
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "panel must be inside verified popover")
changedAudioSource = openAudioSource
changedAudioSource[4]["label"] = "Generate transcript"
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "generation control cannot establish audio ownership")
changedAudioSource = openAudioSource
changedAudioSource[6]["classes"] = ["p-media_transcript"]
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "audio ownership requires popover panel class")
changedAudioSource = openAudioSource
changedAudioSource[8]["url"] = "https://files.slack.com/files-pri/TDEMO-FOTHER/replacement.m4a"
check(try closedAudioSignature != transcriptSourceSignature(changedAudioSource, 100, selectedMediaIndex: 101), "changed audio file URL is not hidden by transcript normalization")
changedAudioSource = openAudioSource
changedAudioSource.append(["index": 140, "parent": 102, "role": "AXButton", "classes": ["c-icon_button"], "label": "View transcript"])
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "duplicate audio transcript openers are ambiguous")
changedAudioSource = openAudioSource
changedAudioSource.append(["index": 141, "parent": 130, "role": "AXGroup", "classes": ["p-media_transcript", "p-media_transcript--popover"]])
check(audioTranscriptBindingRows(changedAudioSource, 101) == nil, "duplicate inline transcript panels are ambiguous")

let audioCloseRows: [[String: Any]] = [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["p-media_transcript", "p-media_transcript--popover"]],
  ["index": 1, "parent": 0, "role": "AXGroup", "classes": ["c-scrollbar__hider"]],
  ["index": 2, "parent": 1, "role": "AXGroup", "classes": ["p-media_transcript__scrollable"]],
  ["index": 3, "parent": 2, "role": "AXGroup", "classes": ["p-media_transcript__action_buttons"]],
  ["index": 4, "parent": 3, "role": "AXButton", "classes": ["p-media_transcript__close_button"], "label": "Close transcript"]
]
check(audioTranscriptCloseIndex(audioCloseRows, 0) == 4, "audio close control requires the observed exact inline panel ancestry")
var changedAudioClose = audioCloseRows
changedAudioClose[4]["parent"] = 2
check(audioTranscriptCloseIndex(changedAudioClose, 0) == nil, "close outside transcript action buttons is rejected")
changedAudioClose = audioCloseRows
changedAudioClose[3]["parent"] = 0
check(audioTranscriptCloseIndex(changedAudioClose, 0) == nil, "close cannot bypass scrollable ancestry")
changedAudioClose = audioCloseRows
changedAudioClose[4]["label"] = "Close"
check(audioTranscriptCloseIndex(changedAudioClose, 0) == nil, "generic Close does not authorize audio dismissal")
changedAudioClose = audioCloseRows
changedAudioClose.append(["index": 5, "parent": 3, "role": "AXButton", "classes": ["p-media_transcript__close_button"], "label": "Close transcript"])
check(audioTranscriptCloseIndex(changedAudioClose, 0) == nil, "duplicate audio close buttons are ambiguous")
changedAudioClose = audioCloseRows
changedAudioClose[0]["classes"] = ["p-media_transcript"]
check(audioTranscriptCloseIndex(changedAudioClose, 0) == nil, "flexpane transcript cannot use inline audio close route")

for (value, seconds) in [("0:00", 0), ("01:02", 62), ("90:00", 5400), ("1:02:03", 3723), ("0 seconds", 0), ("2 seconds", 2), ("1 minute, 10 seconds", 70), ("2 hours, 1 minute, 3 seconds", 7263)] {
  check(transcriptTimestampSeconds(value) == seconds, "transcript spoken and clock timestamps normalize consistently")
}
for value in ["", "unknown", "-1 seconds", "1.5 seconds", "1:60", "1:60:00", "1:2", "1 minute, 1 hour", "1 second 2 seconds", "1 seconds later", "999999999999999999999999999 seconds", "9007199254740992 seconds", "\u{FF11}\u{FF12} seconds"] {
  check(transcriptTimestampSeconds(value) == nil, "unsupported or overflowing transcript timestamp is rejected")
}
func pagingNode(_ index: Int, _ parent: Int?, _ role: String, _ classes: [String], _ label: String = "") -> [String: Any] {
  ["index": index, "parent": parent as Any? ?? NSNull(), "role": role, "classes": classes, "label": label]
}
let videoPagingRows = [
  pagingNode(0, nil, "AXGroup", ["p-media_transcript"]),
  pagingNode(1, 0, "AXButton", ["p-media_transcript__timestamp"], "2 seconds"),
  pagingNode(2, 0, "AXButton", ["p-media_transcript__text"], "first"),
  pagingNode(3, 0, "AXButton", ["p-media_transcript__timestamp"], "1:02"),
  pagingNode(4, 0, "AXButton", ["p-media_transcript__text"], "final"),
  pagingNode(5, 0, "AXGroup", ["p-media_transcript__footer"])
]
let videoPagingSegments = try transcriptSegments(videoPagingRows, audio: false)
check(videoPagingSegments.map { $0.seconds } == [2, 62], "known video structure yields ordered segments")
check(videoPagingSegments.last?.textIndex == 4, "pagination selects final text edge rather than timestamp or footer")
var hiddenVideoRows = [videoPagingRows[0], pagingNode(1, 0, "AXGroup", ["c-scrollbar__hider"])]
for row in videoPagingRows.dropFirst().dropLast() {
  var nested = row
  nested["index"] = (row["index"] as! Int) + 1
  nested["parent"] = 1
  hiddenVideoRows.append(nested)
}
hiddenVideoRows.append(pagingNode(6, 0, "AXGroup", ["p-media_transcript__footer"]))
check((try transcriptSegments(hiddenVideoRows, audio: false)).last?.textIndex == 5, "one direct video scroll hider preserves the final text edge")
func rejectedTranscript(_ rows: [[String: Any]], audio: Bool = false) -> Bool {
  do { _ = try transcriptSegments(rows, audio: audio); return false } catch { return true }
}
func unavailableNode(_ index:Int,_ parent:Int?,_ role:String,_ classes:[String],_ text:String = "") -> [String:Any] {
  var row:[String:Any] = ["index":index,"parent":parent as Any? ?? NSNull(),"role":role,"classes":classes,"id":"","label":text,"AXTitle":role == "AXButton" ? text : "","AXValue":role == "AXStaticText" ? text : "","AXDescription":"","AXHelp":""]
  if role == "AXButton" { row["selected"] = false; row["stateValue"] = "" }
  return row
}
let unavailableVideoRows = [
  unavailableNode(0,nil,"AXGroup",["p-flexpane_body","p-media_transcript"]),
  unavailableNode(1,0,"AXGroup",["p-media_transcript__scrollable"]),
  unavailableNode(2,1,"AXStaticText",[],"Unfortunately, Slack can\u{2019}t provide a transcript of this message."),
  unavailableNode(3,0,"AXGroup",["c-scrollbar__bar"]),
  unavailableNode(4,0,"AXGroup",["p-media_transcript__footer","p-media_transcript__footer-flexpane"]),
  unavailableNode(5,4,"AXGroup",["p-media_transcript__footer_content"]),
  unavailableNode(6,5,"AXStaticText",[],"Not what you expected? "),
  unavailableNode(7,5,"AXButton",["c-link--button"],"Give feedback"),
  unavailableNode(8,5,"AXStaticText",[]," or "),
  unavailableNode(9,5,"AXButton",["c-link--button"],"change language")
]
func unavailableError(_ rows:[[String:Any]]) -> String? {
  do { _ = try transcriptSegments(rows,audio:false); return nil } catch { return String(describing:error) }
}
check(unavailableTranscriptPanel(unavailableVideoRows,audio:false), "exact observed unavailable video panel is recognized")
check(!unavailableTranscriptPanel(unavailableVideoRows,audio:true), "video unavailability cannot establish an audio panel state")
check(unavailableError(unavailableVideoRows) == unavailableTranscriptMessage, "paged reads report Slack unavailability instead of unsupported segment structure")
do { try requireExistingTranscript(unavailableVideoRows,audio:false); fatalError("unavailable initial transcript accepted") }
catch { check(String(describing:error) == unavailableTranscriptMessage, "single-page final source verification also withholds unavailable transcript content") }
for text in ["Transcript is loading", "Generate transcript", "Unfortunately, Slack cannot provide a transcript of this message.", "A transcript may be available later"] {
  var changed = unavailableVideoRows; changed[2]["label"] = text; changed[2]["AXValue"] = text
  check(!unavailableTranscriptPanel(changed,audio:false) && unavailableError(changed) != unavailableTranscriptMessage, "unknown, loading or generation labels are not relabeled as the observed unavailable state")
}
for (index,field,value) in [
  (0,"classes",["p-media_transcript"] as Any),(1,"parent",4 as Any),(2,"role","AXButton" as Any),
  (2,"label","Unfortunately, Slack can\u{2019}t provide a transcript of this message.\n" as Any),(2,"AXValue","different" as Any),
  (2,"classes",["p-media_transcript__text"] as Any),(2,"id","foreign" as Any),(2,"unknown",true as Any),
  (7,"selected",true as Any),(9,"label","Generate transcript" as Any)
] {
  var changed = unavailableVideoRows; changed[index][field] = value
  check(!unavailableTranscriptPanel(changed,audio:false) && unavailableError(changed) != unavailableTranscriptMessage, "changed role, ownership, metadata or footer controls retain the ordinary structural refusal")
}
check(!unavailableTranscriptPanel(Array(unavailableVideoRows.dropLast()),audio:false), "partial unavailable footer is not assumed complete")
var mixedUnavailable = unavailableVideoRows + [pagingNode(10,1,"AXButton",["p-media_transcript__timestamp"],"0 seconds"),pagingNode(11,1,"AXButton",["p-media_transcript__text"],"Mixed real segment")]
check(!unavailableTranscriptPanel(mixedUnavailable,audio:false) && unavailableError(mixedUnavailable) != unavailableTranscriptMessage, "mixed unavailable notice and transcript segments remain unsupported")
mixedUnavailable = videoPagingRows + [unavailableNode(6,0,"AXStaticText",[],"Unfortunately, Slack can\u{2019}t provide a transcript of this message.")]
check(!unavailableTranscriptPanel(mixedUnavailable,audio:false), "an unavailable-looking sibling cannot override a normal transcript layout")
var missingUnavailable = unavailableVideoRows; missingUnavailable[2].removeValue(forKey:"AXHelp")
check(!unavailableTranscriptPanel(missingUnavailable,audio:false), "missing notice metadata cannot establish the exact unavailable state")
var reorderedUnavailable = unavailableVideoRows; reorderedUnavailable.swapAt(3,4)
check(!unavailableTranscriptPanel(reorderedUnavailable,audio:false), "reordered unavailable structure is not accepted")
let nestedUnavailable = unavailableVideoRows + [unavailableNode(10,7,"AXStaticText",[],"Unexpected child")]
check(!unavailableTranscriptPanel(nestedUnavailable,audio:false), "unexpected nested footer content is not discarded")
for (index,field,value) in [(2,"index",1),(0,"parent",1)] {
  var changed = unavailableVideoRows; changed[index][field] = value
  check(!unavailableTranscriptPanel(changed,audio:false), "invalid indices or root ancestry cannot identify unavailable state")
}
try requireExistingTranscript(videoPagingRows,audio:false)
check(true, "available transcript pages retain their existing segment validation path")
var changedPaging = videoPagingRows
changedPaging[4]["role"] = "AXStaticText"
check(rejectedTranscript(changedPaging), "nonbutton transcript edge is rejected")
changedPaging = videoPagingRows
changedPaging[4]["label"] = " "
check(rejectedTranscript(changedPaging), "empty segment cannot become a scroll target")
changedPaging = videoPagingRows
changedPaging[3]["label"] = "1 second"
check(rejectedTranscript(changedPaging), "backward transcript timestamps reject paging")
changedPaging = videoPagingRows
changedPaging[4]["parent"] = 2
check(rejectedTranscript(changedPaging), "nested text segments cannot hide behind accepted button ancestry")
changedPaging = videoPagingRows
changedPaging[4]["index"] = 3
check(rejectedTranscript(changedPaging), "duplicate node identities are rejected before action")
changedPaging = videoPagingRows
changedPaging[1]["parent"] = 4
check(rejectedTranscript(changedPaging), "forward or cyclic parent references reject paging")
changedPaging = videoPagingRows
changedPaging[3]["classes"] = ["p-media_transcript__text"]
check(rejectedTranscript(changedPaging), "unpaired text rejects paging")
changedPaging = videoPagingRows
changedPaging[4]["classes"] = ["p-media_transcript__timestamp"]
check(rejectedTranscript(changedPaging), "unpaired timestamp rejects paging")
changedPaging = videoPagingRows
changedPaging[5]["role"] = "AXTextArea"
check(rejectedTranscript(changedPaging), "unexpected text entry forbids transcript scrolling")
changedPaging = hiddenVideoRows
changedPaging[2]["parent"] = 0
check(rejectedTranscript(changedPaging), "mixed direct and scroll-wrapper segments are unsupported")
changedPaging = hiddenVideoRows
changedPaging[1]["classes"] = ["unknown-wrapper"]
check(rejectedTranscript(changedPaging), "unknown transcript wrapper is not recursively scraped")
check(rejectedTranscript(videoPagingRows, audio: true), "audio paging cannot claim a video panel")

let audioPagingRows = [
  pagingNode(0, nil, "AXGroup", ["p-media_transcript", "p-media_transcript--popover"]),
  pagingNode(1, 0, "AXGroup", ["c-scrollbar__hider"]),
  pagingNode(2, 1, "AXGroup", ["p-media_transcript__scrollable"]),
  pagingNode(3, 2, "AXGroup", ["p-media_transcript__action_buttons"]),
  pagingNode(4, 3, "AXButton", ["p-media_transcript__copy_button"], "Copy"),
  pagingNode(5, 3, "AXButton", ["p-media_transcript__close_button"], "Close transcript"),
  pagingNode(6, 2, "AXHeading", [], "Transcript (auto-generated)"),
  pagingNode(7, 6, "AXStaticText", [], "Transcript (auto-generated)"),
  pagingNode(8, 2, "AXGroup", ["caption", "sk_foreground_max_solid"]),
  pagingNode(9, 8, "AXStaticText", [], "participant"),
  pagingNode(10, 8, "AXStaticText", [], "date"),
  pagingNode(11, 8, "AXStaticText", [], "duration"),
  pagingNode(12, 8, "AXStaticText", [], "language"),
  pagingNode(13, 2, "AXButton", ["p-media_transcript__timestamp"], "0 seconds"),
  pagingNode(14, 2, "AXButton", ["p-media_transcript__text"], "audio segment"),
  pagingNode(15, 0, "AXGroup", ["c-scrollbar__bar"]),
  pagingNode(16, 0, "AXGroup", ["p-media_transcript__footer"])
]
check((try transcriptSegments(audioPagingRows, audio: true)).last?.textIndex == 14, "exact audio popover chooses segment text, never Copy or Close")
changedPaging = audioPagingRows
changedPaging[2]["parent"] = 0
check(rejectedTranscript(changedPaging, audio: true), "audio scrollable cannot bypass exact hider ancestry")
changedPaging = audioPagingRows
changedPaging[5]["label"] = "Close"
check(rejectedTranscript(changedPaging, audio: true), "unknown audio header controls reject paging")
changedPaging = audioPagingRows
changedPaging[6]["label"] = "Generate transcript"
check(rejectedTranscript(changedPaging, audio: true), "generation-looking audio header cannot authorize paging")
changedPaging = audioPagingRows
changedPaging[14]["parent"] = 0
check(rejectedTranscript(changedPaging, audio: true), "audio segment outside scrollable is rejected")
changedPaging = audioPagingRows
changedPaging[9]["role"] = "AXButton"
check(rejectedTranscript(changedPaging, audio: true), "actionable unexpected audio metadata forbids paging")

func pageSegment(_ seconds: Int, _ text: String, _ label: String? = nil) -> TranscriptSegment {
  TranscriptSegment(timestamp: label ?? "\(seconds) seconds", seconds: seconds, text: text, textIndex: 2)
}
let priorTranscript = [pageSegment(0, "first"), pageSegment(5, "same"), pageSegment(5, "same"), pageSegment(10, "last")]
let nextTranscript = [pageSegment(5, "same"), pageSegment(5, "same"), pageSegment(10, "last", "0:10"), pageSegment(15, "new")]
check(try transcriptPageProgress(priorTranscript, nextTranscript) == "advanced", "complete suffix overlap permits later transcript groups with normalized timestamp labels")
check(try transcriptPageProgress(priorTranscript, priorTranscript) == "no-progress", "unchanged transcript page stops without claiming completeness")
check(try transcriptPageProgress(priorTranscript, Array(priorTranscript.suffix(3))) == "no-progress", "exact suffix without later groups is no progress")
check(try transcriptPageProgress(priorTranscript, [pageSegment(10, "last"), pageSegment(11, "new")]) == "advanced", "last complete group is sufficient forward continuity")
check((try transcriptGroups(priorTranscript))[1].texts == ["same", "same"], "duplicate-time duplicate-text occurrences remain distinct")
check(pageSegment(5, "caf\u{E9}") != pageSegment(5, "cafe\u{301}"), "transcript segment equality preserves exact UTF-8 text")
do {
  _ = try transcriptPageProgress([pageSegment(5, "caf\u{E9}")], [pageSegment(5, "cafe\u{301}"), pageSegment(6, "new")])
  fatalError("canonically equivalent text mutation accepted as overlap")
} catch { check(true, "canonically equivalent but byte-different transcript text blocks another scroll") }
for invalid in [
  [pageSegment(5, "same"), pageSegment(10, "last"), pageSegment(15, "new")],
  [pageSegment(5, "changed"), pageSegment(5, "same"), pageSegment(10, "last")],
  [pageSegment(0, "first"), pageSegment(10, "last"), pageSegment(15, "new")],
  [pageSegment(5, "same"), pageSegment(5, "same"), pageSegment(15, "new")],
  [pageSegment(11, "no overlap")],
  [pageSegment(0, "first")],
  [pageSegment(10, "last"), pageSegment(5, "backward")],
  [pageSegment(-1, "negative")],
  [TranscriptSegment](),
  [pageSegment(10, "last"), pageSegment(10, "added to old group")]
] {
  do { _ = try transcriptPageProgress(priorTranscript, invalid); fatalError("invalid transcript overlap accepted") }
  catch { check(true, "changed, missing, partial or reordered transcript groups block another scroll") }
}

func videoLayoutFixture(_ compact: Bool, captionId: String? = nil, url: String? = nil) -> [[String: Any]] {
  var rows: [[String: Any]] = []
  @discardableResult func node(_ parent: Int?, _ role: String, _ classes: [String], _ label: String = "", value: String = "", id: String = "", state: String? = nil, plain: Bool = false) -> Int {
    let index = rows.count
    var row: [String: Any] = ["index": index, "parent": parent as Any? ?? NSNull(), "role": role, "classes": classes, "id": id, "label": label, "AXTitle": plain ? "" : label, "AXDescription": plain ? "" : label, "AXValue": value, "AXHelp": ""]
    if let state { row["stateValue"] = state; row["selected"] = false }
    rows.append(row)
    return index
  }
  let button = ["c-button--focus-visible", "c-button-unstyled", "p-video_controls_overlay__controls__button"]
  node(nil, "AXGroup", ["c-message_kit__actions"])
  let media = node(0, "AXGroup", ["p-video_message_file"])
  let overlay = node(media, "AXGroup", ["p-video_controls_overlay", "p-video_controls_overlay--design_polish", "p-video_controls_overlay--controls"] + (compact ? ["p-video_controls_overlay--design_polish_compact"] : []), "synthetic.mp4")
  let controls = node(overlay, "AXGroup", ["p-video_controls_overlay__controls_container"])
  let scrubber = node(controls, "AXGroup", ["p-video_controls_scrubber", "p-video_controls_overlay__hover"])
  node(scrubber, "AXSlider", ["p-video_controls_scrubber__track"], "Time scrubber")
  let play = node(controls, "AXCheckBox", ["p-video_controls_overlay__controls__pill"], "Play, 5 seconds", state: "0")
  let time = node(play, "AXGroup", ["p-video_controls_overlay__time"])
  node(time, "AXStaticText", [], "0:05", value: "0:05", plain: true)
  let volume = node(controls, "AXGroup", ["p-media_volume_slider"])
  let volumeChildren = node(volume, "AXGroup", ["p-media_volume_slider__children"])
  node(volumeChildren, "AXCheckBox", button + ["p-video_controls_overlay__controls__button--mute"], "Mute", state: "0")
  if compact {
    node(controls, "AXPopUpButton", button + ["p-video_controls_overlay__controls__button--overflow", "p-video_controls_overlay__controls__button--size-small"], "Settings", state: "")
  } else {
    let speed = node(controls, "AXComboBox", ["c-select_button", "c-select_button--small", "c-select_button--text-select"], "Set playback speed: currently 1\u{D7}", value: "1x", id: "playback-speed-abcdefgh_button", state: "1x")
    node(speed, "AXStaticText", [], "1x", value: "1x", plain: true)
    if let captionId {
      let description = node(controls, "AXGroup", ["sr-only"], id: "caption-description-" + captionId)
      node(description, "AXStaticText", [], "Captions are now available for this video.", value: "Captions are now available for this video.", plain: true)
    }
    let captions = node(controls, "AXGroup", [])
    node(captions, "AXCheckBox", button + ["p-video_controls_overlay__controls__caption"], captionId == nil ? "Turn on captions for this video" : "Turn on captions", state: "0")
  }
  let corner = node(overlay, "AXGroup", ["p-video_controls_overlay__corner"])
  node(corner, "AXButton", ["c-icon_button"], "View transcript", state: "")
  let file = node(media, "AXLink", ["filename"], "synthetic.mp4")
  if let url { rows[file]["url"] = url }
  return rows
}
let compactVideoLayout = videoLayoutFixture(true)
let expandedVideoLayout = videoLayoutFixture(false, captionId: "FREVEALED")
let compactVideoSignature = try transcriptSourceSignature(compactVideoLayout, 0)
check(transcriptVideoLayouts(compactVideoLayout).count == 1, "exact compact video settings shape is recognized")
check(transcriptVideoLayouts(expandedVideoLayout).first?.fileId == "FREVEALED", "expanded video settings reveal a file identity for pinning")
check(try compactVideoSignature == transcriptSourceSignature(expandedVideoLayout, 0), "compact and neutral expanded video layouts have identical source signatures")
check(try compactVideoSignature == transcriptSourceSignature(videoLayoutFixture(false), 0), "expanded captions without availability description remain a known neutral shape")
check((try transcriptSourceRows(expandedVideoLayout, 0)).contains { $0["label"] as? String == "View transcript" }, "normalization preserves the exact transcript opener")
func pairedVideoLayouts(_ first: [[String: Any]], _ second: [[String: Any]]) -> [[String: Any]] {
  let offset = first.count - 1
  return first + second.dropFirst().map { row in
    var result = row
    result["index"] = (row["index"] as! Int) + offset
    let parent = row["parent"] as! Int
    result["parent"] = parent == 0 ? 0 : parent + offset
    return result
  }
  }
let pairedCompact = pairedVideoLayouts(compactVideoLayout, compactVideoLayout)
let pairedExpanded = pairedVideoLayouts(expandedVideoLayout, videoLayoutFixture(false))
check(transcriptVideoLayouts(pairedExpanded).count == 2, "selected and sibling genuine video overlays are independently recognized")
check(try transcriptSourceSignature(pairedCompact, 0) == transcriptSourceSignature(pairedExpanded, 0), "one retained message can change both known video layouts without losing either source")
func videoLayoutChanging(_ fixture: [[String: Any]], _ selector: ([String: Any]) -> Bool, _ field: String, _ value: Any) -> [[String: Any]] {
  var result = fixture
  let index = result.firstIndex(where: selector)!
  result[index][field] = value
  return result
}
let speedNode: ([String: Any]) -> Bool = { $0["role"] as? String == "AXComboBox" }
let captionNode: ([String: Any]) -> Bool = { ($0["classes"] as? [String] ?? []).contains("p-video_controls_overlay__controls__caption") }
let descriptionNode: ([String: Any]) -> Bool = { ($0["id"] as? String ?? "").hasPrefix("caption-description-") }
let settingsNode: ([String: Any]) -> Bool = { $0["label"] as? String == "Settings" }
let overlayNode: ([String: Any]) -> Bool = { ($0["classes"] as? [String] ?? []).contains("p-video_controls_overlay") }
for altered in [
  videoLayoutChanging(expandedVideoLayout, speedNode, "stateValue", "2x"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "AXValue", "2x"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "selected", true),
  videoLayoutChanging(expandedVideoLayout, speedNode, "id", "playback-speed-abcdefgh_button\n"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "id", "playback-speed-abcd\u{0}efgh_button"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "url", "https://example.slack.com/files/U1/FOTHER"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "AXHelp", "meaningful help"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "unknownMetadata", "retained"),
  videoLayoutChanging(expandedVideoLayout, speedNode, "classes", ["c-select_button", "unknown"]),
  videoLayoutChanging(expandedVideoLayout, captionNode, "stateValue", "1"),
  videoLayoutChanging(expandedVideoLayout, captionNode, "stateValue", NSNull()),
  videoLayoutChanging(expandedVideoLayout, captionNode, "label", "Turn off captions"),
  videoLayoutChanging(expandedVideoLayout, captionNode, "parent", 3),
  videoLayoutChanging(expandedVideoLayout, descriptionNode, "id", "caption-description-FREVEALED\n"),
  videoLayoutChanging(expandedVideoLayout, descriptionNode, "id", "caption-description-FREVEALED\u{7F}"),
  videoLayoutChanging(expandedVideoLayout, { $0["label"] as? String == "Captions are now available for this video." }, "AXValue", "different description"),
  videoLayoutChanging(expandedVideoLayout, overlayNode, "parent", 0),
  videoLayoutChanging(expandedVideoLayout, overlayNode, "classes", ["p-video_controls_overlay", "unknown"]),
  videoLayoutChanging(expandedVideoLayout, { $0["label"] as? String == "Play, 5 seconds" }, "stateValue", "1"),
  videoLayoutChanging(compactVideoLayout, settingsNode, "AXHelp", "new setting help"),
  videoLayoutChanging(compactVideoLayout, settingsNode, "stateValue", NSNull())
] {
  check(transcriptVideoLayouts(altered).isEmpty, "unknown, nondefault, contradictory or malformed settings shape is never normalized")
}
var addedVideoChild = expandedVideoLayout
addedVideoChild.append(["index": addedVideoChild.count, "parent": 12, "role": "AXButton", "classes": [], "label": "Unexpected action"])
check(transcriptVideoLayouts(addedVideoChild).isEmpty, "extra speed descendant prevents normalization")
for selector in [speedNode, captionNode] {
  var duplicate = expandedVideoLayout
  var child = duplicate.first(where: selector)!
  child["index"] = duplicate.count
  duplicate.append(child)
  check(transcriptVideoLayouts(duplicate).isEmpty, "duplicate speed or caption controls make the layout ambiguous")
}
var reorderedVideoControls = expandedVideoLayout
reorderedVideoControls.swapAt(4, 6)
check(transcriptVideoLayouts(reorderedVideoControls).isEmpty, "reordered direct controls cannot claim the neutral layout")
for altered in [
  videoLayoutChanging(expandedVideoLayout, { $0["role"] as? String == "AXLink" }, "url", "https://example.slack.com/files/U1/FCHANGED"),
  videoLayoutChanging(expandedVideoLayout, { $0["role"] as? String == "AXLink" }, "label", "other.mp4"),
  videoLayoutChanging(expandedVideoLayout, { $0["label"] as? String == "View transcript" }, "label", "Generate transcript"),
  videoLayoutChanging(expandedVideoLayout, { $0["label"] as? String == "Play, 5 seconds" }, "label", "Play, 6 seconds")
] {
  check(try compactVideoSignature != transcriptSourceSignature(altered, 0), "source URL, filename, opener and duration changes remain significant")
}
let knownFileURL = "https://files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4"
let knownCompact = videoLayoutFixture(true, url: knownFileURL)
let matchingExpanded = videoLayoutFixture(false, captionId: "FSOURCE", url: knownFileURL)
let conflictingExpanded = videoLayoutFixture(false, captionId: "FCONFLICT", url: knownFileURL)
check(transcriptVideoLayouts(knownCompact).first?.fileId == "FSOURCE", "known same-player file URL seeds identity before captions are exposed")
check(try transcriptSourceSignature(knownCompact, 0) == transcriptSourceSignature(matchingExpanded, 0), "first revealed caption ID must agree with unchanged known file URL")
check(transcriptVideoLayouts(conflictingExpanded).isEmpty, "conflicting first caption ID is not a normalizable presentation change")
check(try transcriptSourceSignature(knownCompact, 0) != transcriptSourceSignature(conflictingExpanded, 0), "unchanged FSOURCE URL plus new FCONFLICT caption rejects the exact first-reveal regression")
for url in ["HTTPS://files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4", "https://FILES.SLACK.COM/files-pri/TDEMO-FSOURCE/demo.mp4"] {
  let compact = videoLayoutFixture(true, url: url)
  let expanded = videoLayoutFixture(false, captionId: "FCONFLICT", url: url)
  check(transcriptVideoLayouts(compact).first?.fileId == "FSOURCE" && transcriptVideoLayouts(expanded).isEmpty, "case-insensitive trusted URL identity still rejects conflicting caption reveal")
}
for url in ["https://demo.slack.com/files/U1/FSOURCE", "https://files.slack.com/files-tmb/TDEMO-FSOURCE-hash/demo.png"] {
  check(transcriptVideoFileIds(videoLayoutFixture(true, url: url), 1) == ["FSOURCE"], "recognized Slack file-page and thumbnail IDs seed the same media identity")
}
for url in ["https://files.slack.com.evil.test/files-pri/TDEMO-FSOURCE/demo.mp4", "http://files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4"] {
  check(transcriptVideoFileIds(videoLayoutFixture(true, url: url), 1)?.isEmpty == true, "canonical non-Slack or non-HTTPS URLs do not invent a file identity")
}
for url in ["https://user@files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4", "https://demo.slack.com/files/U1/FSOURCE\n", " https://files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4 ", "https://@files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4", "https:\\files.slack.com\\files-pri\\TDEMO-FSOURCE\\demo.mp4", "https:////files.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4", "https://%66iles.slack.com/files-pri/TDEMO-FSOURCE/demo.mp4", "https://files.slack.com/a/../files-pri/TDEMO-FSOURCE/demo.mp4", "https://files.slack.com/a/%2e%2e/files-pri/TDEMO-FSOURCE/demo.mp4"] {
  let compact = videoLayoutFixture(true, url: url)
  let expanded = videoLayoutFixture(false, captionId: "FCONFLICT", url: url)
  check(transcriptVideoFileIds(compact, 1) == nil && transcriptVideoLayouts(compact).isEmpty && transcriptVideoLayouts(expanded).isEmpty, "uncertain URL syntax withholds layout normalization rather than losing an independent file identity")
}
var nestedVideoURL = knownCompact
let nestedIndex = nestedVideoURL.count
nestedVideoURL.append(["index": nestedIndex, "parent": 1, "role": "AXGroup", "classes": ["p-video_message_file"]])
nestedVideoURL.append(["index": nestedIndex + 1, "parent": nestedIndex, "role": "AXLink", "classes": [], "url": "https://demo.slack.com/files/U1/FOTHER"])
check(transcriptVideoFileIds(nestedVideoURL, 1) == ["FSOURCE"], "nested distinct media does not seed the outer player's identity")
for boundary in ["c-message_kit__actions", "p-composer", "p-message_input"] {
  var otherScope = nestedVideoURL
  otherScope[nestedIndex]["classes"] = [boundary]
  check(transcriptVideoFileIds(otherScope, 1) == ["FSOURCE"], "nested message or composer scope cannot seed a video file identity")
}
let retainedVideo = AXUIElementCreateApplication(900001)
let siblingVideo = AXUIElementCreateApplication(900002)
let replacementVideo = AXUIElementCreateApplication(900003)
func layoutPin(_ index: Int, _ id: String? = nil) -> TranscriptVideoLayout {
  TranscriptVideoLayout(mediaIndex: index, overlayIndex: index + 1, omitted: [], fileId: id)
}
let videoPins = TranscriptVideoPins()
try videoPins.observe([layoutPin(1)], [1: retainedVideo])
try videoPins.observe([layoutPin(20, "FSOURCE")], [20: retainedVideo])
try videoPins.observe([layoutPin(1)], [1: retainedVideo])
try videoPins.observe([layoutPin(20, "FSOURCE")], [20: retainedVideo])
check(true, "caption IDs persist across compact hide and matching expanded reveal for retained AX identity")
do { try videoPins.observe([layoutPin(20, "FOTHER")], [20: retainedVideo]); fatalError("changed pinned caption ID accepted") }
catch { check(true, "changed caption ID after hide and reveal is rejected") }
do { try videoPins.observe([layoutPin(20, "FSOURCE")], [20: replacementVideo]); fatalError("replacement AX video accepted") }
catch { check(true, "same metadata on a replacement video object cannot inherit a pin") }
let orderedVideoPins = TranscriptVideoPins()
try orderedVideoPins.observe([layoutPin(1), layoutPin(2)], [1: retainedVideo, 2: siblingVideo])
do { try orderedVideoPins.observe([layoutPin(2), layoutPin(1)], [1: retainedVideo, 2: siblingVideo]); fatalError("identical sibling reorder accepted") }
catch { check(true, "retained video object order is pinned even for indistinguishable siblings") }
do { try orderedVideoPins.observe([layoutPin(1), layoutPin(2)], [1: retainedVideo, 2: retainedVideo]); fatalError("duplicate video identity accepted") }
catch { check(true, "duplicate video identities cannot stand in for distinct siblings") }
let knownVideoPins = TranscriptVideoPins()
try knownVideoPins.observe(transcriptVideoLayouts(knownCompact), [1: retainedVideo])
do { try knownVideoPins.observe([layoutPin(1, "FCONFLICT")], [1: retainedVideo]); fatalError("known URL pin overridden by caption") }
catch { check(true, "previous URL identity cannot be overwritten by a later caption reveal") }
let openerIndex = compactVideoLayout.firstIndex { $0["label"] as? String == "View transcript" }!
check(transcriptControlWithinMedia(compactVideoLayout, 1, openerIndex), "retained transcript control is verified inside retained media")
check(!transcriptControlWithinMedia(compactVideoLayout, 1, 1), "media root itself cannot stand in for retained control")
var displacedControl = compactVideoLayout
displacedControl[openerIndex]["parent"] = 0
check(!transcriptControlWithinMedia(displacedControl, 1, openerIndex), "retained control moved outside selected media is rejected")
var replacedControl = displacedControl
var copyControl = compactVideoLayout[openerIndex]
copyControl["index"] = replacedControl.count
replacedControl.append(copyControl)
check(!transcriptControlWithinMedia(replacedControl, 1, openerIndex), "identical replacement under media cannot excuse displaced retained control")

for label in ["Download", "Download document.pdf", "Download audio file.m4a"] {
  check(downloadLabel(label), "only explicit observed Download labels can offer a candidate")
}
for label in ["Downloading Update", "Download all", "Download ", "Download\nfile.pdf", "download file.pdf", "Save file", "Open", String(repeating: "x", count: 2049)] {
  check(!downloadLabel(label), "bulk, lookalike, empty, oversized and control-character labels reject candidacy")
}
let observedDownloadURL = "https://files.slack.com/files-pri/TDEMO-FFILE/demo.pdf"
for url in [observedDownloadURL, "https://files.slack.com/files-tmb/TDEMO-FFILE-abc123/audio.m4a?download=1", "https://files.slack.com/files-pri/EDEMO-FFILE/demo.png", "HTTPS://FILES.SLACK.COM:443/files-pri/TDEMO-FFILE/demo.pdf"] {
  check(downloadURLAllowed(url), "observed Slack Download URLs retain pri or tmb representation without rewriting")
}
let observedFileDownloadURL = "https://files.slack.com/files-pri/TDEMO-FFILE/download/demo.png"
for url in [observedFileDownloadURL,
  "https://files.slack.com/files-pri/T1-F2/download/r%C3%A9sum%C3%A9%20image.png",
  "https://files.slack.com/files-pri/T1-F2/download/file%23one.png",
  "https://files.slack.com/files-pri/T1-F2/download/file%22%3C%3E%5B%5D%5E%60%7B%7C%7D.png",
  "https://files.slack.com/files-pri/T1-F2/download/azAZ09._~!$&'()*+,;=:@%25.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%3Fv1.png"] {
  check(downloadRouteKind(url) == "file-download", "only canonical observed Slack file-content Download routes are classified")
}
for url in [observedDownloadURL,
  "https://files.slack.com/files-pri/T1-F2-abcd/download/demo.png",
  "https://files.slack.com/files-pri/E1-F2/download/demo.png",
  "https://files.slack.com:443/files-pri/T1-F2/download/demo.png",
  "HTTPS://files.slack.com/files-pri/T1-F2/download/demo.png",
  "https://FILES.SLACK.COM/files-pri/T1-F2/download/demo.png",
  "https://user@files.slack.com/files-pri/T1-F2/download/demo.png",
  "http://files.slack.com/files-pri/T1-F2/download/demo.png",
  "https://files.slack.com.evil.test/files-pri/T1-F2/download/demo.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo.png?download=1",
  "https://files.slack.com/files-pri/T1-F2/download/demo.png#original",
  "https://files.slack.com/files-pri/T1-F2/download/",
  "https://files.slack.com/files-pri/T1-F2/download/demo.png/",
  "https://files.slack.com/files-pri/T1-F2/download/path/demo.png",
  "https://files.slack.com/files-pri/T1-F2/Download/demo.png",
  "https://files.slack.com/files-pri/T1-F2/download/.",
  "https://files.slack.com/files-pri/T1-F2/download/..",
  "https://files.slack.com/files-pri/T1-F2/download/%2e%2e",
  "https://files.slack.com/files-pri/T1-F2/download/path%2Fdemo.png",
  "https://files.slack.com/files-pri/T1-F2/download/path%2fdemo.png",
  "https://files.slack.com/files-pri/T1-F2/download/path%5Cdemo.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%00.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%0A.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%C2%85.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%QQ.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo%FF.png",
  "https://files.slack.com/files-pri/T1-F2/download/r\u{e9}sum\u{e9}.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo\".png",
  "https://files.slack.com/files-pri/T1-F2/download/demo<.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo>.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo[.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo].png",
  "https://files.slack.com/files-pri/T1-F2/download/demo^.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo\u{60}.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo{.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo|.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo}.png",
  "https://files.slack.com/files-pri/T1-F2/download/demo.png\n"] {
  check(downloadRouteKind(url) == "unknown", "ambiguous, rewritten, variant, encoded-traversal and noncanonical routes never gain file-content status")
}
for url in ["https://files.slack.com/files-tmb/TDEMO-FFILE-abc123/audio.mp4",
  "https://files.slack.com/files-tmb/TDEMO-FFILE-abc123/audio.mp4?download=1",
  "https://files.slack.com/files-tmb/TDEMO-FFILE/download/demo.png"] {
  check(downloadRouteKind(url) == "rendition", "a supported thumbnail route stays a rendition regardless of its filename or suffix")
}
for context in ["TDEMO", "EDEMO"] {
  check(downloadRouteKind(observedFileDownloadURL + "?origin_team=" + context, contextId: context) == "file-download", "one exact origin_team query binds the file-content route to its verified workspace or enterprise context")
  check(downloadRouteKind(observedFileDownloadURL, contextId: context) == "file-download", "a query-free canonical file-content route does not invent an origin query")
}
for query in ["origin_team=EOTHER", "origin_team=EDEMO&origin_team=EDEMO", "origin_team=EDEMO&x=1", "origin_team=EDEMO&", "origin_team=%45DEMO", "%6frigin_team=EDEMO", "origin_team=", "Origin_team=EDEMO"] {
  check(downloadRouteKind(observedFileDownloadURL + "?" + query, contextId: "EDEMO") == "unknown", "foreign, duplicate, encoded, additional or noncanonical origin query cannot establish a file-content route")
}
check(downloadRouteKind(observedFileDownloadURL + "?origin_team=EDEMO") == "unknown", "origin query without a verified context remains unknown")
for url in ["http://files.slack.com/files-pri/TDEMO-FFILE/demo.pdf", "https://files.slack.com.evil.test/files-pri/TDEMO-FFILE/demo.pdf", "https://demo.slack.com/files/UDEMO/FFILE/demo.pdf", "https://files.slack.com/files-pri/TDEMO-FFILE/", "https://files.slack.com/files-pri/TDEMO-FFILE/../other", "https://files.slack.com/files-pri/TDEMO-FFILE/%2e%2e/other", "https://files.slack.com:444/files-pri/TDEMO-FFILE/demo.pdf", "https://@files.slack.com/files-pri/TDEMO-FFILE/demo.pdf", "https://files.slack.com/files-pri/TDEMO-FFILE/demo.pdf#fragment", "https://files.slack.com/files-pri/TDEMO-FFILE/demo.pdf\n", " https://files.slack.com/files-pri/TDEMO-FFILE/demo.pdf", "https://%66iles.slack.com/files-pri/TDEMO-FFILE/demo.pdf", "https:\\files.slack.com\\files-pri\\TDEMO-FFILE\\demo.pdf"] {
  check(!downloadURLAllowed(url), "unobserved representation fallbacks and ambiguous or unsafe download URL forms are rejected")
}
func downloadFixture(_ mediaClass: String = "p-message_file") -> [[String: Any]] {
  [
    ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"]],
    ["index": 1, "parent": 0, "role": "AXGroup", "classes": [mediaClass]],
    ["index": 2, "parent": 1, "role": "AXLink", "classes": ["c-link"], "label": "Download document.pdf", "url": observedDownloadURL]
  ]
}
for mediaClass in Array(downloadMediaClasses).sorted() + ["c-message_kit__file"] {
  let targets = downloadTargets(downloadFixture(mediaClass))
  check(targets.count == 1 && targets[0].mediaIndex == 1 && targets[0].containerIndex == 0 && targets[0].controlIndex == 2 && targets[0].url == observedDownloadURL, "download candidate binds its real media and enclosing message indexes")
}
check(downloadTargets(downloadFixture("p-search_file--audio-player"))[0].playbackRequired, "audio downloads require known idle playback")
check(downloadTargets(downloadFixture("p-video_message_file"))[0].playbackRequired, "video downloads require known idle playback")
check(!downloadTargets(downloadFixture())[0].playbackRequired, "ordinary files do not invent playback controls")
var directNativeAudio=downloadFixture()
directNativeAudio[1]["classes"]=["c-pillow_file_container","p-message_file","p-message_file--audio_message"]
let directNativeAudioTarget=downloadTargets(directNativeAudio)[0]
check(directNativeAudioTarget.playbackRequired,"direct native-audio downloads require playback evidence through the same exact audio root predicate")
check(directNativeAudioTarget.mediaIndex == 1 && directNativeAudioTarget.controlIndex == 2,"native audio requiredness preserves its observed media and Download binding")
check(!downloadPlaybackIdle([],required:directNativeAudioTarget.playbackRequired),"a native direct route cannot accept absent playback evidence")
check(downloadPlaybackIdle([["label":"Play","value":"0"]],required:directNativeAudioTarget.playbackRequired),"explicit idle evidence permits the existing direct native audio route")
for value in ["1" as Any,NSNull(),false as Any] {
  check(!downloadPlaybackIdle([["label":"Play","value":value]],required:directNativeAudioTarget.playbackRequired),"direct native audio rejects active or unknown playback evidence")
}
for marker in ["c-pillow_file_container","p-message_file","p-message_file--audio_message"] {
  var rows=directNativeAudio;rows[1]["classes"]=(rows[1]["classes"] as! [String]).filter {$0 != marker}
  check(!downloadTargets(rows)[0].playbackRequired,"the new direct-route requirement is bound to the complete native audio class triple")
}
var alteredDownload = downloadFixture()
alteredDownload[1]["classes"] = ["unknown-media"]
check(downloadTargets(alteredDownload).isEmpty, "unknown media containers cannot own a download")
alteredDownload = downloadFixture()
alteredDownload[0]["classes"] = ["unknown-container"]
check(downloadTargets(alteredDownload).isEmpty, "download outside a message cannot be selected")
alteredDownload = downloadFixture()
alteredDownload[2]["role"] = "AXButton"
check(downloadTargets(alteredDownload).isEmpty, "v1 does not reinterpret arbitrary buttons as observed Download links")
alteredDownload = downloadFixture()
alteredDownload[2]["label"] = "Open document.pdf"
check(downloadTargets(alteredDownload).isEmpty, "Open controls never become download candidates")
alteredDownload = downloadFixture()
alteredDownload[2]["url"] = "https://demo.slack.com/files/UDEMO/FFILE"
check(downloadTargets(alteredDownload).isEmpty, "file page links do not replace a missing Download URL")
alteredDownload = downloadFixture()
alteredDownload.append(["index": 3, "parent": 1, "role": "AXLink", "classes": ["c-link"], "label": "Download document.pdf", "url": observedDownloadURL])
check(downloadTargets(alteredDownload).count == 2, "multiple Download controls are retained for source-bound wrapper selection")
check(downloadTargets(alteredDownload).map { $0.controlIndex } == [2, 3], "same-URL controls retain their separate captured identities")
alteredDownload[2]["url"] = "https://files.slack.com/files-tmb/TDEMO-FFILE-abc123/demo.png"
alteredDownload[3]["url"] = observedFileDownloadURL
let multipleDownloadSignature = try transcriptSourceSignature(alteredDownload, 0, selectedMediaIndex: 1)
let multipleDownloadTargets = downloadTargets(alteredDownload)
check(multipleDownloadTargets.map { $0.routeKind } == ["rendition", "file-download"], "one source can retain both rendition and file-content Download targets")
check(multipleDownloadTargets.allSatisfy { $0.mediaIndex == 1 && $0.containerIndex == 0 }, "multiple routes remain bound to their captured source and attachment")
check(try transcriptSourceSignature(alteredDownload, 0, selectedMediaIndex: 1) == multipleDownloadSignature, "route classification leaves all source evidence unchanged")
var changedDownloadRoutes = alteredDownload
changedDownloadRoutes[3]["url"] = "https://files.slack.com/files-pri/TDEMO-FOTHER/download/demo.png"
check(try transcriptSourceSignature(changedDownloadRoutes, 0, selectedMediaIndex: 1) != multipleDownloadSignature, "changing the file-content target still invalidates source verification")
changedDownloadRoutes = alteredDownload
changedDownloadRoutes[2]["url"] = "https://files.slack.com/files-tmb/TDEMO-FFILE-other/demo.png"
check(try transcriptSourceSignature(changedDownloadRoutes, 0, selectedMediaIndex: 1) != multipleDownloadSignature, "changing a sibling rendition still invalidates source verification")
alteredDownload[3]["url"] = observedFileDownloadURL + "?origin_team=EDEMO"
check(downloadTargets(alteredDownload, contextId: "EDEMO").map { $0.routeKind } == ["rendition", "file-download"], "multi-control candidate inventory carries the verified enterprise context into route classification")
check(downloadTargets(alteredDownload, contextId: "EOTHER").map { $0.routeKind } == ["rendition", "unknown"], "wrong-context route remains exposed but cannot gain file-content status")
alteredDownload = downloadFixture()
alteredDownload[1]["classes"] = ["p-message_file", "p-composer"]
check(downloadTargets(alteredDownload).isEmpty, "composer-owned attachments cannot become save targets")
let nestedDownload: [[String: Any]] = [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"]],
  ["index": 1, "parent": 0, "role": "AXGroup", "classes": ["p-message_file"]],
  ["index": 2, "parent": 1, "role": "AXGroup", "classes": ["p-search_file--audio-player"]],
  ["index": 3, "parent": 2, "role": "AXLink", "classes": ["c-link"], "label": "Download audio.m4a", "url": observedDownloadURL]
]
check(downloadTargets(nestedDownload)[0].mediaIndex == 2, "nested Download control belongs only to its nearest actual media root")
check(downloadPlaybackIdle([], required: false), "files can preserve absence of playback controls")
check(!downloadPlaybackIdle([], required: true), "audio/video with missing playback controls cannot be downloaded blindly")
check(downloadPlaybackIdle([["label": "Play", "value": "0"]], required: true), "explicit stopped playback permits a Download candidate")
for playback in [[["label": "Pause", "value": "1"]], [["label": "Play", "value": NSNull()]], [["label": "Play"]]] as [[[String: Any]]] {
  check(!downloadPlaybackIdle(playback, required: true), "playing or unknown playback is rejected")
}
let sourceRequestData = Data(#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001"}}"#.utf8)
let sourceRequest = try mediaSourceRequest(sourceRequestData,requested:"FFILE1",contextId:"TDEMO")!
check(sourceRequest.workspace == "TDEMO" && sourceRequest.messageRef == "CDEMO:1700000000.000001","source request pins workspace and exact message")
check(sourceRequest.dateFilter == "after:2023-11-13 before:2023-11-16","source date filter is derived from timestamp with timezone-safe UTC day window")
check(try mediaSourceRequest(sourceRequestData,requested:"CDEMO:1700000000.000001/m1",contextId:"TDEMO") != nil,"positional reference may reopen only its own message")
check(try mediaSourceRequest(Data(#"{"token":"download"}"#.utf8),requested:"FFILE1",contextId:"TDEMO") == nil,"Download token never becomes a source reopening request")
check(try mediaSourceRequest(Data(#"{"openViewer":"viewer"}"#.utf8),requested:"FFILE1",contextId:"TDEMO") == nil,"viewer token never becomes a source reopening request")
for (value,requested,context) in [
 (#"{"reopenSource":{"workspace":"TOTHER","messageRef":"CDEMO:1700000000.000001"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001","query":"anything"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001"},"token":"download"}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001"}}"#,"COTHER:1700000000.000001/m1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001"}}"#,"CDEMO:1700000001.000001/m1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001"}}"#,"CDEMO:1700000000.000001/p1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"https://demo.slack.com/archives/CDEMO/p1700000000000001"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001/m1"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO after:2020-01-01"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":"TDEMO","messageRef":"CDEMO:1700000000.000001\n"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{"workspace":true,"messageRef":"CDEMO:1700000000.000001"}}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":true}"#,"FFILE1","TDEMO"),
 (#"{"reopenSource":{}}"#,"FFILE1","TDEMO"),
 (String(repeating:" ",count:4097),"FFILE1","TDEMO")
] {
 do { _ = try mediaSourceRequest(Data(value.utf8),requested:requested,contextId:context);fatalError("invalid source reopening request accepted") }
 catch { check(error is Failure,"invalid source reference/query/workspace cannot authorize navigation") }
}
for (reference,expected) in [("DDEMO:0000000000.000001","after:1969-12-31 before:1970-01-03"),("GDEMO:1730611800.000000","after:2024-11-02 before:2024-11-05")] {
 let data = try JSONSerialization.data(withJSONObject:["reopenSource":["workspace":"EDEMO","messageRef":reference]])
 let value = try mediaSourceRequest(data,requested:"FFILE1",contextId:"EDEMO")!
 check(value.dateFilter == expected,"source query handles DM/group identities, epoch boundary and DST without locale dependence")
}
func sourceObservation(_ rows:[[String:Any]],truncated:Bool = false)->[String:Any] { ["content":["truncated":truncated,"nodes":rows]] }
let absentSourceRows:[[String:Any]] = [["index":0,"parent":NSNull(),"role":"AXGroup","classes":[String]()]]
try requireMediaSourceAbsent([sourceObservation(absentSourceRows),sourceObservation(absentSourceRows)],sourceRequest,requested:"FFILE1")
check(true,"two complete absent-source captures permit only source lookup")
let exposedSourceRows:[[String:Any]] = absentSourceRows + [["index":1,"parent":0,"role":"AXLink","classes":["c-timestamp"],"url":"https://demo.slack.com/archives/CDEMO/p1700000000000001"]]
check(mediaSourceMessageExposed(exposedSourceRows,sourceRequest.message),"canonical source timestamp is recognized")
check(!mediaSourceMessageExposed(exposedSourceRows,try MessageLink("COTHER:1700000000.000001")),"different conversation cannot establish requested source")
check(!mediaSourceMessageExposed(exposedSourceRows,try MessageLink("CDEMO:1700000000.000002")),"different timestamp cannot establish requested source")
let exposedFileRows:[[String:Any]] = [
 ["index":0,"parent":NSNull(),"role":"AXGroup","classes":["c-message_kit__actions"]],
 ["index":1,"parent":0,"role":"AXGroup","classes":["c-pillow_file_container"]],
 ["index":2,"parent":1,"role":"AXLink","classes":[String](),"url":"https://demo.slack.com/files/UDEMO/FFILE1/file.pdf"]
]
var unownedFileRows=exposedFileRows
unownedFileRows[0]["classes"]=["p-download_toast"]
unownedFileRows[1]["classes"]=["c-pillow_file_container","p-download_toast_item"]
try requireMediaSourceAbsent([sourceObservation(unownedFileRows),sourceObservation(unownedFileRows)],sourceRequest,requested:"FFILE1")
check(!messageOwnsSourceMedia(unownedFileRows,1),"requested file in Downloads toast is not an exposed message attachment")
check(messageOwnsSourceMedia(exposedFileRows,1),"message-owned requested file still prevents reopening")
var composerFileRows=exposedFileRows;composerFileRows[0]["classes"]=["c-message_kit__actions","p-composer"]
check(!messageOwnsSourceMedia(composerFileRows,1),"composer ownership cannot become source-message evidence")
var brokenMediaOwner=exposedFileRows;brokenMediaOwner[0]["parent"]=1
check(!messageOwnsSourceMedia(brokenMediaOwner,1),"cyclic ownership cannot become source-message evidence")
var unknownOwnedFile=exposedFileRows;unknownOwnedFile[2]["url"]="not a URL"
do {try requireMediaSourceAbsent([sourceObservation(unknownOwnedFile),sourceObservation(unknownOwnedFile)],sourceRequest,requested:"FFILE1");fatalError("unknown owned file identity permitted reopening")}
catch {check(String(describing:error).contains("unverified file identity"),"unknown owned identity reports uncertainty rather than falsely claiming a match")}

for observations in [[],[sourceObservation(absentSourceRows)],[sourceObservation(exposedSourceRows),sourceObservation(absentSourceRows)],[sourceObservation(absentSourceRows),sourceObservation(exposedSourceRows)],[sourceObservation(exposedFileRows),sourceObservation(absentSourceRows)],[sourceObservation(absentSourceRows),sourceObservation(exposedFileRows)],[sourceObservation(absentSourceRows,truncated:true),sourceObservation(absentSourceRows)],[["content":["truncated":false]],sourceObservation(absentSourceRows)]] as [[[String:Any]]] {
 do {try requireMediaSourceAbsent(observations,sourceRequest,requested:"FFILE1");fatalError("unverified source absence accepted")}
 catch {check(error is Failure,"incomplete captures or an already exposed message/file withhold reopening")}
}

for title in ["demo (Channel) - Workspace - Slack", "* demo (Channel) - Workspace - Slack", "! demo (Channel) - Workspace - Slack"] {
 check(sourceConversationListMatchesTitle(title,"CDEMO","demo (shared channel, 5 unread highlights)"),"shared channel list matches exact title/name/CID with supported unread decoration")
}
check(sourceConversationListMatchesTitle("demo (Channel) - Workspace - Slack","GDEMO","demo (shared channel)"),"shared channel without unread suffix remains typed channel")
check(sourceConversationListMatchesTitle("demo (Channel) - Workspace - Slack","GDEMO","demo (private channel, 2 unread messages)"),"private channel list retains exact Channel title and C/G ID requirements")
for (title,id,list) in [
 ("demo (Channel) - Workspace - Slack","CDEMO","other (shared channel, 5 unread highlights)"),
 ("demo (Channel) - Workspace - Slack","DDEMO","demo (shared channel)"),
 ("demo (DM) - Workspace - Slack","GDEMO","demo (shared channel)"),
 ("demo (Channel) - Workspace - Slack","CDEMO","demo (shared channelish)"),
 ("demo (Channel) - Workspace - Slack","CDEMO","demo (direct message)")
] {
 check(!sourceConversationListMatchesTitle(title,id,list),"shared source readiness rejects wrong name, destination kind and unobserved labels")
}
let emptyGuidance = "You may want to try using different keywords, checking for typos or adjusting filters."
check(searchEmptyLabelsMatch(["Nothing turned up",emptyGuidance]),"observed current empty-result wording is recognized")
check(searchEmptyLabelsMatch(["Nothing turned up","You may want to try using different keywords, checking for typos, or adjusting filters."]),"previous exact empty-result wording remains supported")
check(!searchEmptyLabelsMatch([emptyGuidance]),"guidance alone is not empty-result evidence")
for text in ["", "Loading", emptyGuidance.uppercased(), String(emptyGuidance.dropLast()), emptyGuidance.replacingOccurrences(of:"typos or",with:"typos  or"), "Try searching again"] {
 check(!searchEmptyLabelsMatch(["Nothing turned up",text]),"unobserved empty-result copy remains unsupported")
}
let resetScopeRecord:[String:Any] = ["role":"AXButton","id":"","label":"Reset","value":"","selected":false,"classes":["c-button--focus-visible","c-button-unstyled","p-search_filter__reset_button"]]
check(searchScopeOwnerMatches("AXGroup",["p-view_contents","p-view_contents--sidebar"],"Search",searchViewCount:1,ownerIsSearchView:true,ownerWithinSearchView:true),"filters and results may share the observed direct Search view owner")
check(searchScopeOwnerMatches("AXGroup",["c-scrollbar__hider"],"",searchViewCount:1,ownerIsSearchView:false,ownerWithinSearchView:true),"the existing scrollbar owner remains supported within its unique Search view")
for count in [0,2] {
  check(!searchScopeOwnerMatches("AXGroup",["p-view_contents"],"Search",searchViewCount:count,ownerIsSearchView:true,ownerWithinSearchView:true),"missing or ambiguous Search views cannot own scope controls")
}
for (role,classes,label,isView,within) in [("AXButton",["p-view_contents"],"Search",true,true),("AXGroup",[String](),"Search",true,true),("AXGroup",["p-view_contents"],"Conversation",true,true),("AXGroup",["p-view_contents"],"Search",false,true),("AXGroup",["c-scrollbar__hider"],"",false,false),("AXGroup",["p-view_contents"],"Search",true,false),("AXGroup",[String](),"Search",false,true)] {
  check(!searchScopeOwnerMatches(role,classes,label,searchViewCount:1,ownerIsSearchView:isView,ownerWithinSearchView:within),"wrong roles, lookalike owners and foreign ancestry never authorize a Search scope")
}
check(passiveSearchReset(resetScopeRecord,directFilterChild:true,childCount:0,hasURL:false),"observed passive Reset is scope evidence without an invented DOM ID")
let resetBaseClasses = ["c-button-unstyled","p-search_filter__reset_button"]
for names in [resetBaseClasses,Array(resetBaseClasses.reversed())] {
 var record=resetScopeRecord;record["classes"]=names
 check(passiveSearchReset(record,directFilterChild:true,childCount:0,hasURL:false),"unfocused Reset accepts exactly its observed base classes in either order")
 for (key,value) in [("role","AXPopUpButton"),("id","reset"),("label","Reset all"),("value","1")] {
  var changed=record;changed[key]=value
  check(!passiveSearchReset(changed,directFilterChild:true,childCount:0,hasURL:false),"unfocused Reset retains role, ID, label and state checks")
 }
 for value in [true,NSNull()] as [Any] {
  var changed=record;changed["selected"]=value
  check(!passiveSearchReset(changed,directFilterChild:true,childCount:0,hasURL:false),"unfocused Reset cannot be selected or unknown")
 }
 for (direct,count,url) in [(false,0,false),(true,1,false),(true,0,true)] {
  check(!passiveSearchReset(record,directFilterChild:direct,childCount:count,hasURL:url),"unfocused Reset preserves direct ancestry, leaf and no-URL guards")
 }
}
for names in [[String](),[resetBaseClasses[0]],[resetBaseClasses[1]],resetBaseClasses+["extra"],resetBaseClasses+[resetBaseClasses[0]],resetBaseClasses+[resetBaseClasses[1]],resetBaseClasses+["c-button--focus-visible","c-button--focus-visible"]] {
 var record=resetScopeRecord;record["classes"]=names
 check(!passiveSearchReset(record,directFilterChild:true,childCount:0,hasURL:false),"Reset never accepts incomplete, duplicated or unknown class sets")
}
for (key,value) in [("role","AXPopUpButton"),("id","reset"),("label","Reset all"),("value","1")] {
 var record=resetScopeRecord;record[key]=value
 check(!passiveSearchReset(record,directFilterChild:true,childCount:0,hasURL:false),"lookalike Reset control cannot bypass missing-ID guard")
}
for value in [true, NSNull()] as [Any] {
 var record=resetScopeRecord;record["selected"]=value
 check(!passiveSearchReset(record,directFilterChild:true,childCount:0,hasURL:false),"changed or unknown Reset selection is refused")
}
for names in [["c-button--focus-visible","c-button-unstyled"],["c-button--focus-visible","c-button-unstyled","p-search_filter__reset_button","extra"]] {
 var record=resetScopeRecord;record["classes"]=names
 check(!passiveSearchReset(record,directFilterChild:true,childCount:0,hasURL:false),"Reset requires exactly its observed classes")
}
for (direct,count,url) in [(false,0,false),(true,1,false),(true,0,true)] {
 check(!passiveSearchReset(resetScopeRecord,directFilterChild:direct,childCount:count,hasURL:url),"moved, interactive-child or URL-bearing Reset remains unsupported")
}
let feedbackScopeRecord:[String:Any] = ["role":"AXButton","id":"","label":"Give feedback","value":"","selected":false,"classes":["c-link--button"]]
var focusedFeedbackScope = feedbackScopeRecord
focusedFeedbackScope["classes"] = ["c-link--focus-visible", "c-link--button"]
check(passiveSearchFeedback(focusedFeedbackScope,directFilterChild:true,childCount:0,hasURL:false),"focus styling does not change passive feedback identity")
check(passiveSearchFeedback(feedbackScopeRecord,directFilterChild:true,childCount:0,hasURL:false),"observed feedback is retained as passive scope evidence with its real empty ID")
for (key,value) in [("role","AXPopUpButton"),("id","feedback"),("label","Send feedback"),("value","1")] {
 var record=feedbackScopeRecord;record[key]=value
 check(!passiveSearchFeedback(record,directFilterChild:true,childCount:0,hasURL:false),"lookalike feedback cannot bypass missing-ID guard")
}
for value in [true, NSNull()] as [Any] {
 var record=feedbackScopeRecord;record["selected"]=value
 check(!passiveSearchFeedback(record,directFilterChild:true,childCount:0,hasURL:false),"changed or unknown feedback selection is refused")
}
for names in [[String](),["c-link--button","extra"],["c-link--button","c-link--button"],["c-button-unstyled"]] {
 var record=feedbackScopeRecord;record["classes"]=names
 check(!passiveSearchFeedback(record,directFilterChild:true,childCount:0,hasURL:false),"feedback requires exactly its observed class")
}
for (direct,count,url) in [(false,0,false),(true,1,false),(true,0,true)] {
 check(!passiveSearchFeedback(feedbackScopeRecord,directFilterChild:direct,childCount:count,hasURL:url),"moved, non-leaf or URL-bearing feedback is refused")
}
check(searchScopeIDsValid(["search-filter-sort-filter",""],passiveKinds:[nil,"reset"]),"one verified idless Reset can coexist with unique named filters")
check(searchScopeIDsValid(["search-filter-sort-filter",""],passiveKinds:[nil,"feedback"]),"one verified idless feedback can coexist with unique named filters")
check(searchScopeIDsValid(["search-filter-sort-filter","",""],passiveKinds:[nil,"reset","feedback"]),"two distinct verified passive kinds preserve real empty IDs without ambiguity")
check(searchScopeIDsValid(["feedback",""],passiveKinds:[nil,"feedback"]),"named DOM IDs cannot collide with passive-kind identity")
let invalidScopeIdentities: [([String],[String?])] = [
 (["",""],["reset","reset"]),(["",""],["feedback","feedback"]),
 (["sort","sort"],[nil,nil]),(["sort",""],[nil,nil]),(["sort",""],["reset"]),
 ([],[]),(["sort",""],[nil,"unknown"])
]
for (ids,kinds) in invalidScopeIdentities {
 check(!searchScopeIDsValid(ids,passiveKinds:kinds),"duplicate passive controls, duplicate named controls and unknown idless scope remain invalid")
}
check(sourceIDQueryMatches("CDEMO", "CDEMO", optionCount: 2, exactQueryCount: 1), "exact ID query requires complete unique navigation/query pair")
check(sourceIDQueryMatches("CDEMO \u{2014} Search", "CDEMO", optionCount: 2, exactQueryCount: 1), "source-only picker permits observed presentation suffix independently of pseudo-selection")
for (value,options,queryCount) in [("COTHER",2,1),("CDEMO \u{2014} Searchx",2,1),("CDEMO",1,1),("CDEMO",3,1),("CDEMO",2,0),("CDEMO",2,2)] {
 check(!sourceIDQueryMatches(value,"CDEMO",optionCount:options,exactQueryCount:queryCount),"changed/incomplete/ambiguous ID query cannot authorize Return")
}
func sourceScopeFixture()->[[String:Any]] { [
 ["index":0,"parent":NSNull(),"role":"AXGroup","classes":[String]()],
 ["index":1,"parent":0,"role":"AXComboBox","label":"Query","AXValue":"in:demo-channel Channel  ","classes":["ql-editor"]],
 ["index":2,"parent":1,"role":"AXGroup","label":"in:demo-channel Channel","classes":["c-member_slug--search-filter"]],
 ["index":3,"parent":2,"role":"AXStaticText","label":"in:","classes":[String]()],
 ["index":4,"parent":2,"role":"AXStaticText","label":"demo-channel","classes":[String]()],
 ["index":5,"parent":0,"role":"AXCheckBox","id":"quick-filter-in-CDEMO","label":"In this channel","stateValue":"1","classes":["c-filter-pill--active"]]
] }
func scopeContent(_ rows:[[String:Any]],truncated:Bool=false)->[String:Any] {["nodes":rows,"truncated":truncated]}
check(sourceChannelScope(scopeContent(sourceScopeFixture()),"CDEMO") == "demo-channel","scoped query derives only observed token bound to exact channel ID")
check(sourceChannelScope(scopeContent(sourceScopeFixture()),"COTHER") == nil,"same channel name cannot replace exact conversation ID")
check(sourceChannelScope(scopeContent(sourceScopeFixture(),truncated:true),"CDEMO") == nil,"truncated scope capture cannot authorize query")
for (index,key,value) in [
 (1,"AXValue","in:demo-channel Channel extra"),(2,"label","in:other Channel"),
 (3,"label","from:"),(4,"label","demo-channel OR in:other"),(4,"label","@person"),
 (5,"id","quick-filter-in-UDEMO"),(5,"label","In this DM"),(5,"stateValue","0"),(5,"role","AXButton")
] {
 var rows=sourceScopeFixture(); rows[index][key]=value
 check(sourceChannelScope(scopeContent(rows),"CDEMO") == nil,"changed/unbound scope token or filter withholds source search")
}
var brokenScope=sourceScopeFixture();brokenScope[2]["parent"]=0
check(sourceChannelScope(scopeContent(brokenScope),"CDEMO") == nil,"scope token outside Query cannot prove search binding")
brokenScope=sourceScopeFixture();brokenScope[2]["parent"]=2
check(sourceChannelScope(scopeContent(brokenScope),"CDEMO") == nil,"cyclic scope ownership cannot prove search binding")
brokenScope=sourceScopeFixture();brokenScope.append(["index":6,"parent":0,"role":"AXCheckBox","classes":["c-filter-pill--active"]])
check(sourceChannelScope(scopeContent(brokenScope),"CDEMO") == nil,"another active filter invalidates exact scoped search")
brokenScope=sourceScopeFixture();brokenScope.append(["index":6,"parent":1,"role":"AXGroup","classes":["c-member_slug--search-filter"]])
check(sourceChannelScope(scopeContent(brokenScope),"CDEMO") == nil,"duplicate scope tokens cannot authorize source search")

check(try downloadSelectionToken(Data(#"{"token":"offered"}"#.utf8), ["offered"]) == "offered", "only offered Download capability is accepted")
for input in [#"{"token":"other"}"#, #"{"token":"offered","url":"https://example.test"}"#, #"{"cancel":true}"#, "null", "[]", String(repeating: " ", count: 4097)] {
  do { _ = try downloadSelectionToken(Data(input.utf8), ["offered"]); fatalError("invalid download capability accepted") }
  catch { check(true, "cancelled or invented Download capabilities cannot trigger input") }
}
try downloadFinishRequest(Data(#"{"finish":true}"#.utf8))
check(true, "explicit wrapper completion ends native monitoring")
for input in [#"{"finish":false}"#, #"{"finish":1}"#, #"{"finish":"true"}"#, #"{"finish":true,"token":"offered"}"#, #"{"cancel":true}"#, "null", "[]", String(repeating: " ", count: 4097)] {
  do { try downloadFinishRequest(Data(input.utf8)); fatalError("unverified download completion accepted") }
  catch { check(true, "missing, malformed or nonboolean completion cannot report success") }
}
try downloadWorkspaceCheckpointRequest(Data(#"{"verifyWorkspace":true}"#.utf8))
check(true, "one explicit boolean checkpoint authorizes fresh no-input workspace verification")
for input in [#"{"verifyWorkspace":false}"#, #"{"verifyWorkspace":1}"#, #"{"verifyWorkspace":"true"}"#, #"{"verifyWorkspace":true,"finish":true}"#, #"{"verifyWorkspace":true,"token":"offered"}"#, #"{"finish":true}"#, #"{"cancel":true}"#, "null", "[]", "{}", "{", String(repeating: " ", count: 4097)] {
  do { try downloadWorkspaceCheckpointRequest(Data(input.utf8)); fatalError("unverified workspace checkpoint accepted") }
  catch { check(true, "early finish, cancelled, malformed or nonboolean checkpoint cannot authorize publication") }
}
do { try downloadFinishRequest(Data(#"{"verifyWorkspace":true}"#.utf8)); fatalError("duplicate workspace checkpoint accepted as completion") }
catch { check(true, "a second checkpoint is refused by the subsequent finish phase") }

// Viewer input is a separate capability and only becomes available when the
// selected image has no raw Download control of its own.
let viewerURL = "https://files.slack.com/files-pri/TDEMO-FFILE/demo.png"
for value in [viewerURL, viewerURL + "?origin_team=TDEMO", viewerURL + "?origin_team=EDEMO", "https://files.slack.com/files-pri/TDEMO-FFILE/hello%20world%F0%9F%8C%8D.png"] {
  let context = value.hasSuffix("EDEMO") ? "EDEMO" : "TDEMO"
  let file = viewerImageIdentity(value, contextId: context)
  check(file?.fileId == "FFILE" && file?.ownerTeamId == "TDEMO", "viewer source identity preserves observed owner and file")
}
for value in [
  viewerURL + "?origin_team=TOTHER", viewerURL + "?origin_team=EOTHER",
  viewerURL + "?origin_team=TDEMO&extra=1", viewerURL + "?origin_team=TDEMO&origin_team=TDEMO",
  viewerURL + "?origin%5Fteam=TDEMO", viewerURL + "#fragment", viewerURL + "?", viewerURL + "\n",
  "https://files.slack.com/files-pri/EDEMO-FFILE/demo.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE-preview/demo.png",
  "https://files.slack.com/files-tmb/TDEMO-FFILE/demo.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/download/demo.png",
  "http://files.slack.com/files-pri/TDEMO-FFILE/demo.png",
  "HTTPS://files.slack.com/files-pri/TDEMO-FFILE/demo.png",
  "https://FILES.slack.com/files-pri/TDEMO-FFILE/demo.png",
  "https://files.slack.com:443/files-pri/TDEMO-FFILE/demo.png",
  "https://user@files.slack.com/files-pri/TDEMO-FFILE/demo.png",
  "https://files.slack.com.evil.test/files-pri/TDEMO-FFILE/demo.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/../demo.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/%2e%2e",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%2fother.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%5cother.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%00.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%C2%85.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%2.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo%GG.png",
  "https://files.slack.com/files-pri/TDEMO-FFILE/demo image.png"
] {
  check(viewerImageIdentity(value, contextId: "TDEMO") == nil, "noncanonical or conflicting viewer URL cannot authorize an opener")
}
check(viewerImageIdentity(viewerURL + "?origin_team=TDEMO", contextId: nil) == nil, "unverified context cannot accept origin_team")
func viewerSourceFixture() -> [[String: Any]] { [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"], "label": "Original message"],
  ["index": 1, "parent": 0, "role": "AXGroup", "classes": ["p-message_gallery_image_file", "c-file_gallery_image_file"]],
  ["index": 2, "parent": 1, "role": "AXLink", "classes": ["p-file_image_thumbnail__wrapper"], "url": viewerURL, "label": "demo.png"],
  ["index": 3, "parent": 2, "role": "AXImage", "classes": ["p-file_image_thumbnail__image"], "url": "https://files.slack.com/files-tmb/TDEMO-FFILE-thumb/demo.png"]
] }
let viewerOpeners = viewerOpenerTargets(viewerSourceFixture(), contextId: "TDEMO")
check(viewerOpeners.count == 1, "observed image gallery offers exactly one viewer opener")
check(viewerOpeners[0].containerIndex == 0 && viewerOpeners[0].mediaIndex == 1 && viewerOpeners[0].controlIndex == 2, "viewer opener retains source and control ownership")
check(viewerOpeners[0].sourceURL == viewerURL && viewerOpeners[0].identity.fileId == "FFILE", "viewer opener binds byte-exact source URL and file")
for role in ["AXLink", "AXButton", "AXMenuItem"] {
  for label in ["Download", "Download demo.png"] {
    var rows = viewerSourceFixture()
    rows.append(["index": 4, "parent": 1, "role": role, "classes": ["disabled"], "label": label, "url": "https://invalid.example/download"])
    check(viewerOpenerTargets(rows, contextId: "TDEMO").isEmpty, "raw source-owned Download prevents fallback even when unsupported or disabled")
  }
}
for (index, field, replacement) in [
  (0, "classes", ["unknown-message"] as Any), (0, "role", "AXTextArea" as Any),
  (1, "classes", ["p-message_gallery_image_file"] as Any),
  (1, "classes", ["c-file_gallery_image_file"] as Any), (1, "role", "AXLink" as Any),
  (2, "classes", ["unknown-opener"] as Any), (2, "role", "AXButton" as Any),
  (2, "url", viewerURL + "?origin_team=TOTHER" as Any),
  (3, "classes", ["unknown-image"] as Any), (3, "role", "AXGroup" as Any),
  (3, "url", "https://files.slack.com/files-tmb/TDEMO-FOTHER-thumb/demo.png" as Any)
] {
  var rows = viewerSourceFixture(); rows[index][field] = replacement
  check(viewerOpenerTargets(rows, contextId: "TDEMO").isEmpty, "changed gallery, opener or thumbnail identity rejects fallback")
}
for (role, names, label) in [
  ("AXGroup", ["p-message_file"], ""), ("AXGroup", ["c-message_kit__actions"], ""),
  ("AXTextField", [String](), ""), ("AXTextArea", [String](), ""),
  ("AXGroup", ["p-composer__input"], ""), ("AXGroup", ["p-message_input"], ""),
  ("AXButton", [String](), "Play"), ("AXCheckBox", [String](), "Pause video")
] {
  var rows = viewerSourceFixture()
  rows.append(["index": 4, "parent": 1, "role": role, "classes": names, "label": label])
  check(viewerOpenerTargets(rows, contextId: "TDEMO").isEmpty, "nested media, compose surfaces and players cannot become image openers")
}
for original in [2, 3] {
  var rows = viewerSourceFixture(), duplicate = rows[original]
  duplicate["index"] = 4; rows.append(duplicate)
  check(viewerOpenerTargets(rows, contextId: "TDEMO").isEmpty, "ambiguous opener or thumbnail stops fallback")
}
for name in ["p-composer", "p-message_input", "p-workspace__input", "p-media_viewer_modal"] {
  var rows = viewerSourceFixture(); rows[0]["classes"] = ["c-message_kit__actions", name]
  check(viewerOpenerTargets(rows, contextId: "TDEMO").isEmpty, "viewer clones and compose ancestors cannot supply original source")
}
var unrelatedDownloadSource = viewerSourceFixture()
unrelatedDownloadSource.append(["index": 4, "parent": 0, "role": "AXLink", "classes": ["c-link"], "label": "Download another file"])
check(viewerOpenerTargets(unrelatedDownloadSource, contextId: "TDEMO").count == 1, "unrelated sibling Download does not suppress the selected gallery")
let viewerSourceSignature = try transcriptSourceSignature(viewerSourceFixture(), 0, selectedMediaIndex: 1)
for index in 0..<4 {
  var rows = viewerSourceFixture(); rows[index]["label"] = "changed source"
  check(try transcriptSourceSignature(rows, 0, selectedMediaIndex: 1) != viewerSourceSignature, "every source row remains covered by retained source signature")
}
func closeToolbarFixture(_ start:Int=100)->[[String:Any]] {
 let parents=[0,start,start+1,start+2,start+1,start+4,start+1,start+6,start+1,start+1,start+1,start+1,start+1,start+12,start+1]
 let root=["c-message_actions__container","c-message__actions","c-message__actions--offscreen"]
 let reaction=["c-button--focus-visible","c-button-unstyled","c-message_actions__button","c-message_actions__emoji_button"]
 let button=["c-button--focus-visible","c-button-unstyled","c-icon_button","c-icon_button--size_smedium","c-message_actions__button","c-icon_button--default"]
 var rows:[[String:Any]]=[]
 func append(_ role:String,_ names:[String],_ label:String="",state:String?=nil,url:String?=nil) {
  let offset=rows.count
  var row:[String:Any]=["index":start+offset,"parent":parents[offset],"role":role,"classes":names,"id":"","label":label,"AXTitle":label,"AXDescription":label,"AXValue":"","AXHelp":""]
  if let state {row["stateValue"]=state;row["selected"]=false}
  if let url {row["url"]=url}
  rows.append(row)
 }
 append("AXGroup",root)
 append("AXGroup",["c-message_actions__group","c-message-actions--hover-actions"],"Message actions")
 for (name,label,code) in [("white_check_mark","white check mark emoji","2705"),("eyes","eyes emoji","1f440"),("raised_hands","raised hands emoji","1f64c")] {
  append("AXCheckBox",reaction,"React with \(name)",state:"0")
  append("AXImage",["c-emoji","c-emoji__small"],label,url:"https://a.slack-edge.com/production-standard-emoji-assets/16.0/apple-small/\(code)@2x.png")
 }
 for label in ["Add reaction\u{2026}","Reply in thread","Forward message\u{2026}","Add to-do"] {append("AXButton",button,label,state:"")}
 append("AXGroup",["container__z3l0C"])
 append("AXButton",button,"Add to list\u{2026}",state:"")
 append("AXPopUpButton",button+["c-message_actions__button--more"],"More actions",state:"")
 return rows
}
let closeSourceRows=viewerSourceFixture()+[
 ["index":4,"parent":0,"role":"AXLink","classes":["c-timestamp"],"url":"https://demo.slack.com/archives/DDEMO/p1700000000000001"],
 ["index":5,"parent":0,"role":"AXStaticText","classes":[String](),"label":"Original message body"]
]
let closeSourceSignature=try transcriptSourceSignature(closeSourceRows,0,selectedMediaIndex:1)
let closeBaseline=ViewerCloseSourceBaseline(rows:closeSourceRows,mediaIndex:1)
let closeToolbar=closeToolbarFixture()
let addedToolbarRows=closeSourceRows+closeToolbar
check(try viewerSourceCheck(closeSourceRows,mediaIndex:1,originalSignature:closeSourceSignature) == "unchanged","ordinary source checks preserve exact unchanged behavior")
check(try viewerSourceCheck(addedToolbarRows,mediaIndex:1,originalSignature:closeSourceSignature) == nil,"known toolbar addition still fails every ordinary pre-Download/monitor signature check")
check(try viewerSourceCheck(addedToolbarRows,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == "added-offscreen-toolbar","post-close-only exception accepts exactly verified added toolbar and unchanged raw remainder")
check(try viewerSourceCheck(closeSourceRows,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == "unchanged","post-close exact match reports unchanged rather than claiming exception usage")
let insertedToolbarRows=Array(closeSourceRows.prefix(1))+closeToolbar+Array(closeSourceRows.dropFirst())
check(try viewerSourceCheck(insertedToolbarRows,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == "added-offscreen-toolbar","direct source-child insertion preserves all original row order without assuming toolbar is last")
check(viewerAddedOffscreenToolbar(addedToolbarRows,rootIndex:0,mediaIndex:1)?.count == 15,"toolbar validator bounds precisely the observed fifteen added rows")
for offset in 0..<15 {
 for field in ["role","classes","label","id","AXTitle","AXDescription","AXValue","AXHelp"] {
  var changed=addedToolbarRows
  changed[closeSourceRows.count+offset][field]=field == "classes" ? ["unknown"] as Any : "changed" as Any
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"every toolbar row role/class/label/metadata field must match observed inert presentation")
 }
 var changed=addedToolbarRows;changed[closeSourceRows.count+offset]["unknownField"]="unverified"
 check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"unknown captured attributes cannot be hidden in the post-close exception")
 changed=addedToolbarRows;changed[closeSourceRows.count+offset]["parent"]=offset == 0 ? 1:0
 check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"moved toolbar or child ownership must remain fail-closed")
}
for offset in [2,4,6,8,9,10,11,13,14] {
 for (field,value) in [("selected",true as Any),("stateValue","1" as Any),("stateValue",NSNull()),("url",viewerURL as Any)] {
  var changed=addedToolbarRows;changed[closeSourceRows.count+offset][field]=value
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"selected, unknown-state or URL-bearing actions cannot be dismissed as new inert toolbar")
 }
}
for offset in [3,5,7] {
 for url in ["https://example.test/emoji.png","https://a.slack-edge.com/production-standard-emoji-assets/16.0/apple-small/other@2x.png",viewerURL] {
  var changed=addedToolbarRows;changed[closeSourceRows.count+offset]["url"]=url
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"only the exact observed standard emoji URLs may be omitted")
 }
}
for extra in [
 ["index":200,"parent":100,"role":"AXGroup","classes":["p-composer"]],
 ["index":200,"parent":101,"role":"AXLink","classes":["c-link"],"url":viewerURL],
 ["index":200,"parent":101,"role":"AXGroup","classes":["p-message_file"]],
 ["index":200,"parent":0,"role":"AXGroup","classes":["c-message_actions__foreign"]]
] as [[String:Any]] {
 check(try viewerSourceCheck(addedToolbarRows+[extra],mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"unknown children, media, links and foreign action markers prevent omission")
}
check(try viewerSourceCheck(addedToolbarRows+closeToolbarFixture(200),mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"duplicate toolbar roots anywhere in source cannot be normalized")
var reorderedToolbar=addedToolbarRows;reorderedToolbar.swapAt(closeSourceRows.count+8,closeSourceRows.count+9)
check(try viewerSourceCheck(reorderedToolbar,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"toolbar child encounter order remains exact")
for (index,field,value) in [(0,"label","Edited source" as Any),(1,"classes",["p-message_gallery_image_file"] as Any),(2,"url",viewerURL+"?changed" as Any),(3,"url",viewerURL as Any),(4,"url","https://demo.slack.com/archives/DDEMO/p1700000000000002" as Any),(5,"label","Edited message body" as Any),(2,"parent",0 as Any)] {
 var changed=addedToolbarRows;changed[index][field]=value
 check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"valid toolbar addition never hides edited source message, media, permalink or opener ancestry")
}
var reorderedSource=addedToolbarRows;reorderedSource.swapAt(4,5)
check(try viewerSourceCheck(reorderedSource,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"original source encounter order is retained exactly")
var highlightedSource=closeSourceRows;highlightedSource[0]["label"]="\u{E000}Original message\u{E001}"
check(try transcriptSourceSignature(highlightedSource,0,selectedMediaIndex:1) == closeSourceSignature,"control proves ordinary transcript highlighting normalization would otherwise hide this change")
check(try viewerSourceCheck(highlightedSource+closeToolbar,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"toolbar exception cannot combine with unrelated source normalization")
let existingToolbarSignature=try transcriptSourceSignature(addedToolbarRows,0,selectedMediaIndex:1)
let existingToolbarBaseline=ViewerCloseSourceBaseline(rows:addedToolbarRows,mediaIndex:1)
check(try viewerSourceCheck(addedToolbarRows,mediaIndex:1,originalSignature:existingToolbarSignature,postCloseBaseline:existingToolbarBaseline) == "unchanged","existing toolbar passes only unchanged strict verification")
var changedExisting=addedToolbarRows;changedExisting[closeSourceRows.count+2]["selected"]=true
for rows in [changedExisting,closeSourceRows,addedToolbarRows+closeToolbarFixture(200)] {
 check(try viewerSourceCheck(rows,mediaIndex:1,originalSignature:existingToolbarSignature,postCloseBaseline:existingToolbarBaseline) == nil,"existing toolbar mutation, removal or duplicate is never excused")
}
var falseBaselineRows=closeSourceRows;falseBaselineRows[5]["label"]="Another message"
check(try viewerSourceCheck(addedToolbarRows,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:ViewerCloseSourceBaseline(rows:falseBaselineRows,mediaIndex:1)) == nil,"post-close baseline must already verify against immutable original source signature")
check(try viewerRawSourceSignature(closeSourceRows,0) == viewerRawSourceSignature(closeSourceRows.map { row in var value=row;value["index"]=(row["index"] as! Int)+50;if let parent=row["parent"] as? Int {value["parent"]=parent+50};return value },50),"raw post-close comparison normalizes only relative indices and parents")

func closeToolbarVariants() -> [(String,[[String:Any]])] {
 let base=closeToolbarFixture()
 func named(_ value:String)->[[String:Any]] {
  var rows=base
  for field in ["label","AXTitle","AXDescription"] {rows[9][field]=value}
  return rows
 }
 var noThread=base;noThread.remove(at:9)
 var compact=[base[0],base[1],base[12],base[8],base[9],base[10],base[11],base[14],base[14]]
 let parents=[0,100,101,102,101,101,101,101,101]
 for i in compact.indices {compact[i]["index"]=100+i;compact[i]["parent"]=parents[i]}
 compact[2]["classes"]=["container___lGTS"]
 compact[7]["classes"]=base[8]["classes"]
 for field in ["label","AXTitle","AXDescription"] {compact[7][field]="Ask Slackbot"}
 var compactNoThread=compact;compactNoThread.remove(at:4)
 return [("legacy-in",base),("legacy-to",named("Reply to thread")),("legacy-view",named("View thread")),("legacy-no-thread",noThread),("slackbot-in",compact),("slackbot-no-thread",compactNoThread)]
}
let observedToolbarVariants=closeToolbarVariants()
for (variant,toolbar) in observedToolbarVariants {
 let rows=closeSourceRows+toolbar
 check(viewerAddedOffscreenToolbar(rows,rootIndex:0,mediaIndex:1)?.count == toolbar.count,"each finite observed variant is structurally accepted: \(variant)")
 check(try viewerSourceCheck(rows,mediaIndex:1,originalSignature:closeSourceSignature) == nil,"every variant remains unavailable to ordinary pre-Download verification: \(variant)")
 check(try viewerSourceCheck(rows,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == "added-offscreen-toolbar","each variant can only explain an addition after Close with unchanged raw source: \(variant)")
 let existingSignature=try transcriptSourceSignature(rows,0,selectedMediaIndex:1)
 let existingBaseline=ViewerCloseSourceBaseline(rows:rows,mediaIndex:1)
 check(try viewerSourceCheck(rows,mediaIndex:1,originalSignature:existingSignature,postCloseBaseline:existingBaseline) == "unchanged","existing toolbar still uses only unchanged verification: \(variant)")
 var changedExisting=rows;changedExisting[closeSourceRows.count]["AXHelp"]="changed"
 check(try viewerSourceCheck(changedExisting,mediaIndex:1,originalSignature:existingSignature,postCloseBaseline:existingBaseline) == nil,"a prior toolbar cannot change through new-layout support: \(variant)")
 check(try viewerSourceCheck(closeSourceRows,mediaIndex:1,originalSignature:existingSignature,postCloseBaseline:existingBaseline) == nil,"a prior toolbar cannot disappear through new-layout support: \(variant)")
 for offset in toolbar.indices {
  for field in ["role","classes","label","AXTitle","AXDescription","AXValue","AXHelp","id"] {
   var changed=rows;changed[closeSourceRows.count+offset][field]=field == "classes" ? ["unknown"] as Any:"unknown" as Any
   check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"unknown structural or metadata field cannot hide in \(variant)")
  }
  var changed=rows;changed[closeSourceRows.count+offset]["unknownAttribute"]="unverified"
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"extra fields remain significant in \(variant)")
  changed=rows;changed[closeSourceRows.count+offset]["parent"]=offset == 0 ? 1:0
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"moved node or gallery-owned toolbar cannot be normalized in \(variant)")
  changed=rows;changed[closeSourceRows.count+offset]["url"]="https://example.test/unknown"
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"unknown URL cannot hide in \(variant)")
  if toolbar[offset]["stateValue"] != nil {
   for (field,value) in [("selected",true as Any),("stateValue",NSNull()),("stateValue","1" as Any)] {
    changed=rows;changed[closeSourceRows.count+offset][field]=value
    check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"unknown, active or selected control state cannot hide in \(variant)")
   }
  }
 }
 var duplicate=toolbar
 for i in duplicate.indices {
  duplicate[i]["index"]=(duplicate[i]["index"] as! Int)+200
  if let parent=duplicate[i]["parent"] as? Int,parent != 0 {duplicate[i]["parent"]=parent+200}
 }
 check(try viewerSourceCheck(rows+duplicate,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"duplicate complete \(variant) toolbar cannot be normalized")
 var extra=rows;extra.append(["index":500,"parent":101,"role":"AXGroup","classes":["p-message_file"]])
 check(try viewerSourceCheck(extra,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"extra child cannot hide in \(variant)")
 var reordered=rows;reordered.swapAt(rows.count-1,rows.count-2)
 check(try viewerSourceCheck(reordered,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"ordered whole-shape match rejects reordered \(variant)")
 for (index,field,value) in [(0,"label","Edited message" as Any),(2,"url",viewerURL+"?other" as Any),(4,"url","https://demo.slack.com/archives/DDEMO/p1700000000000002" as Any),(5,"label","Edited body" as Any),(2,"parent",0 as Any)] {
  var changed=rows;changed[index][field]=value
  check(try viewerSourceCheck(changed,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"\(variant) never weakens raw source, permalink, media or ancestry checks")
 }
}
let compactToolbar=observedToolbarVariants[4].1
for label in ["Reply to thread","View thread"] {
 var hybrid=compactToolbar
 for field in ["label","AXTitle","AXDescription"] {hybrid[4][field]=label}
 check(try viewerSourceCheck(closeSourceRows+hybrid,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"legacy thread labels cannot form unobserved Slackbot combinations")
}
var legacyWithSlackbot=closeToolbarFixture()
legacyWithSlackbot[12]=compactToolbar[7];legacyWithSlackbot[12]["index"]=112
legacyWithSlackbot.remove(at:13)
check(try viewerSourceCheck(closeSourceRows+legacyWithSlackbot,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"legacy emoji actions cannot arbitrarily substitute Slackbot for Add to list")
var emojiFragment=Array(closeToolbarFixture()[2...7])
for i in emojiFragment.indices {
 emojiFragment[i]["index"]=(emojiFragment[i]["index"] as! Int)+200
 let parent=emojiFragment[i]["parent"] as! Int;emojiFragment[i]["parent"]=parent == 101 ? 101:parent+200
}
let hybridEmoji=Array(compactToolbar.prefix(2))+emojiFragment+Array(compactToolbar.dropFirst(2))
check(try viewerSourceCheck(closeSourceRows+hybridEmoji,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"legacy emoji prefix cannot be combined with compact wrapped reaction and Slackbot controls")
var movedWrapper=compactToolbar;movedWrapper[3]["parent"]=101
check(try viewerSourceCheck(closeSourceRows+movedWrapper,mediaIndex:1,originalSignature:closeSourceSignature,postCloseBaseline:closeBaseline) == nil,"compact Add reaction must remain owned by its exact observed wrapper")

var visibleFileToolbar = compactToolbar
visibleFileToolbar[0]["classes"] = ["c-message_actions__container","c-message__actions"]
for field in ["label","AXTitle","AXDescription"] {visibleFileToolbar[5][field]="Forward file\u{2026}"}
let fileVisibleRows = closeSourceRows + visibleFileToolbar
var fileOffscreenRows = fileVisibleRows
fileOffscreenRows[closeSourceRows.count]["classes"] = ["c-message_actions__container","c-message__actions","c-message__actions--offscreen"]
let fileVisibleSignature = try transcriptSourceSignature(fileVisibleRows,0,selectedMediaIndex:1)
let normalizedFileVisibleRows = try JSONSerialization.jsonObject(with:viewerRawSourceSignature(fileVisibleRows,0)) as! [[String:Any]]
let toolbarHandle = AXUIElementCreateApplication(730000)
let fileOpeningBaseline = ViewerToolbarVisibilityBaseline(element:toolbarHandle,rows:normalizedFileVisibleRows,mediaIndex:1)
check(viewerFileToolbar(fileVisibleRows,rootIndex:0,mediaIndex:1,offscreen:false)?.count == 9,"the observed existing compact file toolbar is matched as one complete visible shape")
check(viewerFileToolbar(fileOffscreenRows,rootIndex:0,mediaIndex:1,offscreen:true)?.count == 9,"only the offscreen root marker distinguishes the same known toolbar shape")
check(try viewerToolbarBecameOffscreen(fileOffscreenRows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"the exact existing toolbar may gain its one observed offscreen marker")
check(try viewerSourceCheck(fileOffscreenRows,mediaIndex:1,originalSignature:fileVisibleSignature) == nil,"the visibility transition is unavailable without retained owned-viewer proof")
check(try viewerSourceCheck(fileOffscreenRows,mediaIndex:1,originalSignature:fileVisibleSignature,openingToolbarBaseline:fileOpeningBaseline) == "existing-toolbar-offscreen","owned-viewer opening reports the narrowly verified transition")
check(try !viewerToolbarBecameOffscreen(fileVisibleRows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"unchanged visibility is not reported as an opening transition")
let afterBaseline = ViewerToolbarVisibilityBaseline(element:toolbarHandle,rows:fileOffscreenRows,mediaIndex:1)
check(try !viewerToolbarBecameOffscreen(fileVisibleRows,mediaIndex:1,originalSignature:transcriptSourceSignature(fileOffscreenRows,0,selectedMediaIndex:1),baseline:afterBaseline),"reverse marker changes cannot use the opening exception")
check(try !viewerToolbarBecameOffscreen(fileOffscreenRows,mediaIndex:2,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"a different selected media offset cannot inherit the toolbar transition")
check(try !viewerToolbarBecameOffscreen(fileOffscreenRows,mediaIndex:1,originalSignature:closeSourceSignature,baseline:fileOpeningBaseline),"retained raw baseline must still verify against the original signature")
let wrongMediaBaseline = ViewerToolbarVisibilityBaseline(element:toolbarHandle,rows:normalizedFileVisibleRows,mediaIndex:2)
check(try !viewerToolbarBecameOffscreen(fileOffscreenRows,mediaIndex:2,originalSignature:fileVisibleSignature,baseline:wrongMediaBaseline),"a non-gallery baseline node cannot stand in for selected media")
var twoGalleryBefore=fileVisibleRows
for row in Array(closeSourceRows[1...3]) {var copy=row;copy["index"]=(row["index"] as! Int)+500;if let parent=row["parent"] as? Int,parent != 0 {copy["parent"]=parent+500};twoGalleryBefore.append(copy)}
var twoGalleryAfter=twoGalleryBefore;twoGalleryAfter[closeSourceRows.count]["classes"] = fileOffscreenRows[closeSourceRows.count]["classes"]
let twoGalleryBaseline = ViewerToolbarVisibilityBaseline(element:toolbarHandle,rows:try JSONSerialization.jsonObject(with:viewerRawSourceSignature(twoGalleryBefore,0)) as! [[String:Any]],mediaIndex:1)
let twoGallerySignature=try transcriptSourceSignature(twoGalleryBefore,0,selectedMediaIndex:1)
check(try viewerToolbarBecameOffscreen(twoGalleryAfter,mediaIndex:1,originalSignature:twoGallerySignature,baseline:twoGalleryBaseline),"unchanged duplicate image content does not alter the selected retained media offset")
check(try !viewerToolbarBecameOffscreen(twoGalleryAfter,mediaIndex:501,originalSignature:twoGallerySignature,baseline:twoGalleryBaseline),"another valid identical gallery cannot inherit the selected image identity through raw equality")
let sourceHandles = Dictionary(uniqueKeysWithValues:fileVisibleRows.map {($0["index"] as! Int,AXUIElementCreateApplication(pid_t(740000+($0["index"] as! Int))))})
let retainedFileOpeners = try viewerOpenerCandidates(["content":["truncated":false,"nodes":fileVisibleRows]],sourceHandles,contextId:"TDEMO")
check(retainedFileOpeners.count == 1 && retainedFileOpeners[0].toolbarBaseline != nil && CFEqual(retainedFileOpeners[0].toolbarBaseline!.element,sourceHandles[100]!),"preflight retains the actual known toolbar AX identity beside its exact raw source")
check(try viewerRawSourceSignature(retainedFileOpeners[0].toolbarBaseline!.rows,0) == viewerRawSourceSignature(fileVisibleRows,0),"retained toolbar baseline preserves every raw source field")
for offset in visibleFileToolbar.indices {
  for field in ["role","classes","label","id","AXTitle","AXDescription","AXValue","AXHelp"] {
    var rows = fileOffscreenRows; rows[closeSourceRows.count+offset][field] = field == "classes" ? ["unknown"] as Any : "changed" as Any
    check(try !viewerToolbarBecameOffscreen(rows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"every toolbar field remains significant during opening")
  }
  for (field,value) in [("unknownField","unverified" as Any),("parent",1 as Any),("url",viewerURL as Any)] {
    var rows = fileOffscreenRows; rows[closeSourceRows.count+offset][field] = value
    check(try !viewerToolbarBecameOffscreen(rows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"foreign metadata, source ancestry and URLs cannot hide behind visibility")
  }
  if visibleFileToolbar[offset]["stateValue"] != nil {
    for (field,value) in [("selected",true as Any),("stateValue","1" as Any),("stateValue",NSNull())] {
      var rows = fileOffscreenRows; rows[closeSourceRows.count+offset][field] = value
      check(try !viewerToolbarBecameOffscreen(rows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"active or unknown toolbar state cannot be normalized")
    }
  }
}
for (index,field,value) in [(0,"label","Edited source" as Any),(1,"classes",["p-message_gallery_image_file"] as Any),(2,"url",viewerURL+"?changed" as Any),(4,"url","https://demo.slack.com/archives/DDEMO/p1700000000000002" as Any),(5,"label","Edited body" as Any),(2,"parent",0 as Any)] {
  var rows=fileOffscreenRows;rows[index][field]=value
  check(try !viewerToolbarBecameOffscreen(rows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"opening visibility never weakens body, permalink, image or control ancestry")
}
var highlightFileRows=fileOffscreenRows;highlightFileRows[0]["label"]="\u{E000}Original message\u{E001}"
check(try transcriptSourceSignature(highlightFileRows,0,selectedMediaIndex:1) == transcriptSourceSignature(fileOffscreenRows,0,selectedMediaIndex:1),"ordinary highlighting normalization would otherwise hide a concurrent raw change")
check(try !viewerToolbarBecameOffscreen(highlightFileRows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"the new branch requires raw equality and cannot compose unrelated normalizations")
var reorderedFileRows=fileOffscreenRows;reorderedFileRows.swapAt(4,5)
var reorderedClasses=fileOffscreenRows;reorderedClasses[closeSourceRows.count]["classes"]=["c-message__actions","c-message_actions__container","c-message__actions--offscreen"]
var duplicateFileRows=fileOffscreenRows
for row in visibleFileToolbar {var copy=row;copy["index"]=(row["index"] as! Int)+200;if let parent=row["parent"] as? Int,parent != 0 {copy["parent"]=parent+200};duplicateFileRows.append(copy)}
for rows in [reorderedFileRows,reorderedClasses,duplicateFileRows,closeSourceRows,fileOffscreenRows+[["index":500,"parent":101,"role":"AXButton","classes":[String](),"label":"Unknown"]]] {
  check(try !viewerToolbarBecameOffscreen(rows,mediaIndex:1,originalSignature:fileVisibleSignature,baseline:fileOpeningBaseline),"row/class order, duplicates, deletion and unknown child additions remain forbidden")
}
let acceptedFileClose = ViewerCloseSourceBaseline(rows:fileOffscreenRows,mediaIndex:1,openingToolbarBaseline:fileOpeningBaseline)
check(try viewerSourceCheck(fileOffscreenRows,mediaIndex:1,originalSignature:fileVisibleSignature,postCloseBaseline:acceptedFileClose) == "retained-offscreen-toolbar","verified closure may preserve exactly the already accepted offscreen source")
check(try viewerSourceCheck(fileVisibleRows,mediaIndex:1,originalSignature:fileVisibleSignature,postCloseBaseline:acceptedFileClose) == "unchanged","closure may restore the exact immutable original source")
check(try viewerSourceCheck(fileOffscreenRows,mediaIndex:1,originalSignature:fileVisibleSignature,postCloseBaseline:ViewerCloseSourceBaseline(rows:fileOffscreenRows,mediaIndex:1)) == nil,"post-close visibility needs explicit verified opening evidence")
for rows in [highlightFileRows,reorderedFileRows,reorderedClasses,duplicateFileRows,closeSourceRows] {
  check(try viewerSourceCheck(rows,mediaIndex:1,originalSignature:fileVisibleSignature,postCloseBaseline:acceptedFileClose) == nil,"post-close retained visibility never excuses any further source change")
}

func viewerModalFixture() -> [[String: Any]] { [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["ReactModal__Content", "ReactModal__Content--after-open", "c-sk-modal", "c-sk-modal--fullscreen", "p-media_viewer_modal"]],
  ["index": 1, "parent": 0, "role": "AXGroup", "classes": ["p-media_viewer_modal__messages", "p-media_viewer_modal__multimedia"]],
  ["index": 2, "parent": 1, "role": "AXGroup", "classes": ["p-media_viewer_modal__multimedia_video"]],
  ["index": 3, "parent": 2, "role": "AXGroup", "classes": ["p-file_viewer"]],
  ["index": 4, "parent": 3, "role": "AXGroup", "classes": ["p-file_viewer__content"]],
  ["index": 5, "parent": 4, "role": "AXGroup", "classes": ["p-image_viewer"]],
  ["index": 6, "parent": 5, "role": "AXImage", "classes": ["p-image_viewer__image"], "url": viewerURL],
  ["index": 7, "parent": 2, "role": "AXToolbar", "classes": ["p-media_viewer_modal__footer"]],
  ["index": 8, "parent": 7, "role": "AXButton", "classes": ["p-file_viewer__header__button", "p-media_viewer_modal__icon_button"], "label": "Download"],
  ["index": 9, "parent": 1, "role": "AXButton", "classes": ["p-media_viewer_modal__tabs_close"], "label": "Close"]
] }
let viewerTarget = viewerDownloadTarget(viewerModalFixture(), sourceURL: viewerURL)
check(viewerTarget != nil, "captured image viewer structure supports an exact URL-less Download")
func modernViewerFixture() -> [[String:Any]] {
  var rows = viewerModalFixture()
  rows[7]["classes"] = ["p-media_viewer_modal__footer","p-media_viewer_modal__footer--slide_over_content"]
  rows[7]["id"] = ""; rows[7]["label"] = "Media controls"
  rows[8]["classes"] = ["c-button-unstyled","c-icon_button","c-icon_button--size_medium","p-media_viewer_modal__icon_button","c-icon_button--dark"]
  rows[8]["id"] = ""; rows[8]["selected"] = false; rows[8]["stateValue"] = ""; rows[8]["AXValue"] = ""
  return rows
}
let modernViewer = modernViewerFixture()
check(viewerDownloadTarget(modernViewer,sourceURL:viewerURL)?.controlIndex == 8,"observed modern footer preserves source-bound URL-less Download without the legacy header class")
var focusedModernViewer = modernViewer
focusedModernViewer[8]["classes"] = ["c-button--focus-visible"] + (modernViewer[8]["classes"] as! [String])
check(viewerDownloadTarget(focusedModernViewer,sourceURL:viewerURL)?.controlIndex == 8,"observed focused Download accepts only its explicit sixth class")
for removed in modernViewer[8]["classes"] as! [String] {
  var rows = focusedModernViewer; rows[8]["classes"] = (rows[8]["classes"] as! [String]).filter {$0 != removed}
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"focused variant cannot omit any base Download class")
}
for extra in ["unknown","c-button--focus-visible","c-icon_button"] {
  var rows = focusedModernViewer; rows[8]["classes"] = (rows[8]["classes"] as! [String]) + [extra]
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"focused variant rejects duplicate and unknown classes")
}
check(viewerDownloadTarget(focusedModernViewer,sourceURL:viewerURL+"?changed") == nil,"focus decoration never relaxes the exact source URL")
for index in [7,8] {
  let names = modernViewer[index]["classes"] as! [String]
  for omitted in names {
    var rows = modernViewer; rows[index]["classes"] = names.filter {$0 != omitted}
    check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"every observed modern footer and button class is required")
  }
  for extra in ["unknown",names[0]] {
    var rows = modernViewer; rows[index]["classes"] = names + [extra]
    check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"unknown and duplicate classes cannot enter the modern Download variant")
  }
  var reversed = modernViewer; reversed[index]["classes"] = Array(names.reversed())
  check(viewerDownloadTarget(reversed,sourceURL:viewerURL) != nil,"modern class membership does not depend on serialization order")
}
for (index,field,value) in [
  (7,"id","foreign" as Any),(7,"label","Controls" as Any),(7,"url",viewerURL as Any),
  (8,"id","foreign" as Any),(8,"selected",true as Any),(8,"stateValue","1" as Any),
  (8,"AXValue","Download" as Any),(8,"url",viewerURL as Any),(8,"label","Download original" as Any),
  (6,"url",viewerURL+"?changed" as Any),(7,"role","AXGroup" as Any),(8,"role","AXLink" as Any),
  (7,"parent",3 as Any),(8,"parent",3 as Any),(9,"parent",7 as Any)
] {
  var rows = modernViewer; rows[index][field] = value
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"modern Download retains exact source, footer, control state and Close ancestry")
}
for (index,field) in [(7,"id"),(7,"label"),(8,"id"),(8,"selected"),(8,"stateValue"),(8,"AXValue")] {
  var rows = modernViewer; rows[index].removeValue(forKey:field)
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"unknown modern state cannot be treated as the observed empty or false value")
}
for parent in [7,8] {
  var rows = modernViewer
  if parent == 7 {var duplicate=rows[8];duplicate["index"]=10;rows.append(duplicate)}
  else {rows.append(["index":10,"parent":8,"role":"AXStaticText","label":"unexpected"])}
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"duplicate Download or a non-leaf modern control is refused")
}
var branchCloseViewer = viewerModalFixture()
branchCloseViewer[9]["parent"] = 2
let branchCloseTarget = viewerDownloadTarget(branchCloseViewer, sourceURL: viewerURL)
check(branchCloseTarget?.closeIndex == 9 && branchCloseTarget?.closeParentIndex == 2, "observed DM image viewer binds Close directly to its sole active image branch")
check(viewerTarget?.closeParentIndex == 1, "original viewer layout retains multimedia Close owner")
var decoratedBranchViewer = branchCloseViewer
decoratedBranchViewer[6]["classes"] = ["p-image_viewer__image", "p-image_viewer__image--png"]
decoratedBranchViewer[9]["classes"] = ["p-media_viewer_modal__tabs_close", "p-media_viewer_modal__tabs_close--slide_over_content"]
decoratedBranchViewer.append(["index":10,"parent":7,"role":"AXButton","classes":["p-media_viewer_modal__alt_button"],"label":"Add description"])
check(viewerDownloadTarget(decoratedBranchViewer,sourceURL:viewerURL)?.closeParentIndex == 2,"observed PNG and Add description presentation retains exact image and Close ownership")
for placement in [1,2] {
 for foreignParent in [0,1,2,3,7,99] {
  var rows=viewerModalFixture();rows[9]["parent"]=placement
  var foreign=rows[9];foreign["index"]=10;foreign["parent"]=foreignParent;rows.append(foreign)
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"duplicate known Close anywhere in the viewer refuses both supported placements")
 }
 for foreignParent in [0,3,5,7,99] {
  var rows=viewerModalFixture();rows[9]["parent"]=foreignParent
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"Close must remain a direct child of multimedia or the sole active branch")
 }
 for (field,value) in [("label","Close something else"),("role","AXLink")] {
  var rows=viewerModalFixture();rows[9]["parent"]=placement
  var foreign=rows[9];foreign["index"]=10;foreign["parent"]=0;foreign[field]=value;rows.append(foreign)
  check(viewerDownloadTarget(rows,sourceURL:viewerURL) == nil,"known-class foreign Close remains ambiguous even with altered role or label")
 }
}
var nestedBranchClose=branchCloseViewer
nestedBranchClose.insert(["index":10,"parent":2,"role":"AXGroup","classes":[String]()],at:9)
nestedBranchClose[10]["parent"]=10
check(viewerDownloadTarget(nestedBranchClose,sourceURL:viewerURL) == nil,"nested Close cannot use the new direct-branch placement")
var ordinaryForeignClose=branchCloseViewer
ordinaryForeignClose.append(["index":10,"parent":0,"role":"AXButton","classes":["unrelated"],"label":"Close"])
check(viewerDownloadTarget(ordinaryForeignClose,sourceURL:viewerURL)?.closeParentIndex == 2,"unrelated ordinary Close is not mistaken for the typed viewer-close capability")

check(viewerTarget?.viewerIndex == 0 && viewerTarget?.branchIndex == 2 && viewerTarget?.mediaIndex == 3 && viewerTarget?.imageIndex == 6 && viewerTarget?.footerIndex == 7 && viewerTarget?.controlIndex == 8 && viewerTarget?.closeIndex == 9, "scoped active image, Download, Close and ownership indexes are explicit")
for index in 0..<10 {
  for field in ["classes", "role"] {
    var rows = viewerModalFixture(); rows[index][field] = field == "classes" ? ["unknown"] as Any : "AXUnknown" as Any
    check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "required viewer role and class mutations cannot retain Download permission")
  }
  var rows = viewerModalFixture(); rows.remove(at: index)
  check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "missing viewer component cannot retain Download permission")
}
for index in 1..<10 {
  var rows = viewerModalFixture(); rows[index]["parent"] = 99
  check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "viewer component reparenting invalidates source ownership")
}
for index in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] {
  var rows = viewerModalFixture(), duplicate = rows[index]
  duplicate["index"] = 10; rows.append(duplicate)
  check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "duplicate modal, branch, media, image or control cannot be guessed")
}
for name in ["ReactModal__Content", "ReactModal__Content--after-open", "c-sk-modal", "c-sk-modal--fullscreen"] {
  var rows = viewerModalFixture(); rows[0]["classes"] = (rows[0]["classes"] as! [String]).filter { $0 != name }
  check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "all observed modal identity classes are required")
}
for (index, field, replacement) in [
  (6, "url", viewerURL + "?origin_team=TDEMO" as Any),
  (6, "url", "https://files.slack.com/files-pri/TDEMO-FOTHER/demo.png" as Any),
  (6, "url", NSNull()), (8, "url", viewerURL as Any),
  (8, "label", "Download original" as Any), (8, "label", "Download\n" as Any),
  (9, "label", "Close something else" as Any),
  (8, "classes", ["p-file_viewer__header__button"] as Any),
  (8, "classes", ["p-media_viewer_modal__icon_button"] as Any)
] {
  var rows = viewerModalFixture(); rows[index][field] = replacement
  check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "different image URL or altered control receipt prevents Download")
}
for role in ["AXButton", "AXCheckBox"] {
  for label in ["Play", "Pause", "Play video", "Pause audio"] {
    var rows = viewerModalFixture()
    rows.append(["index": 10, "parent": 2, "role": role, "classes": [String](), "label": label])
    check(viewerDownloadTarget(rows, sourceURL: viewerURL) == nil, "unsupported player viewer never reaches Download")
  }
}
var withViewerThread = viewerModalFixture()
withViewerThread.append(["index": 10, "parent": 0, "role": "AXGroup", "classes": ["p-threads_flexpane"]])
withViewerThread.append(["index": 11, "parent": 10, "role": "AXButton", "classes": [String](), "label": "Download other file"])
withViewerThread.append(["index": 12, "parent": 10, "role": "AXCheckBox", "classes": [String](), "label": "Play"])
check(viewerDownloadTarget(withViewerThread, sourceURL: viewerURL)?.controlIndex == 8, "cloned message controls outside the multimedia branch never replace the active viewer Download")
check(try viewerRequest(Data(#"{"openViewer":"opener"}"#.utf8), ["opener"]) == "opener", "only offered opener token authorizes opening")
check(try viewerRequest(Data(#"{"token":"download"}"#.utf8), ["opener"]) == nil, "Download capability never becomes a viewer opener")
for value in [#"{"openViewer":"stale"}"#, #"{"openViewer":1}"#, #"{"openViewer":true}"#, #"{"openViewer":null}"#, #"{"openViewer":"opener","token":"download"}"#, #"{"openViewer":"opener","url":"https://example.test"}"#, "invalid", String(repeating: " ", count: 4097)] {
  do { _ = try viewerRequest(Data(value.utf8), ["opener"]); fatalError("invalid viewer opening request accepted") }
  catch { check(true, "malformed or forged opening request cannot authorize input") }
}

// The observed Download tooltip remains noninteractive to this helper. The
// separate live gate also requires one owned source-bound viewer and its focused Download.
func downloadTooltipFixture() -> [[String:Any]] {
  let names = [
    ["ReactModal__Overlay","ReactModal__Overlay--after-open","c-popover","c-popover--z_menu","c-popover--fade","c-popover--no-pointer"],
    ["ReactModal__Content","ReactModal__Content--after-open","popover","c-popover__content"],
    ["c-tooltip__tip","c-tooltip__tip--top","c-tooltip__tip--small"],[],["c-tooltip__tip__arrow"]
  ]
  return (0..<5).map { index -> [String:Any] in
    var row:[String:Any] = ["index":index,"classes":names[index],"AXDescription":"","AXHelp":""]
    row["parent"] = index == 0 ? NSNull() : [0,0,1,2,2][index] as Any
    row["role"] = index == 3 ? "AXStaticText" : "AXGroup"
    row["id"] = index == 1 ? "sk-tooltip-123" : ""
    row["label"] = [1,3].contains(index) ? "Download" : ""
    row["AXTitle"] = index == 1 ? "Download" : ""
    row["AXValue"] = index == 3 ? "Download" : ""
    return row
  }
}
let tooltipFixture = downloadTooltipFixture()
check(viewerDownloadTooltip(tooltipFixture,subrole:"AXUserInterfaceTooltip"),"exact captured passive overlay and Download tooltip shape is recognized")
for subrole in ["","AXDialog","AXApplicationDialog","AXUnknown"] {
  check(!viewerDownloadTooltip(tooltipFixture,subrole:subrole),"tooltip text never substitutes for the actual AX tooltip subrole")
}
for index in 0..<5 {
  for key in tooltipFixture[index].keys {
    var rows = tooltipFixture; rows[index].removeValue(forKey:key)
    check(!viewerDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"every tooltip field must remain known")
  }
  var unknown = tooltipFixture; unknown[index]["unknown"] = ""
  check(!viewerDownloadTooltip(unknown,subrole:"AXUserInterfaceTooltip"),"unrecognized tooltip attributes are not ignored")
  for field in ["role","label","AXTitle","AXValue","AXDescription","AXHelp","index","parent","id"] {
    var rows = tooltipFixture; rows[index][field] = ["index","parent"].contains(field) ? 99 as Any : "foreign" as Any
    check(!viewerDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"changed tooltip ancestry, role, text, identity or metadata is refused")
  }
  let names = tooltipFixture[index]["classes"] as! [String]
  for name in names {
    var rows = tooltipFixture; rows[index]["classes"] = names.filter {$0 != name}
    check(!viewerDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"all observed overlay and tooltip classes are mandatory")
  }
  for extra in ["unknown"] + Array(names.prefix(1)) {
    var rows = tooltipFixture; rows[index]["classes"] = names + [extra]
    check(!viewerDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"foreign or duplicate tooltip classes are rejected")
  }
  var reordered = tooltipFixture; reordered[index]["classes"] = Array(names.reversed())
  check(viewerDownloadTooltip(reordered,subrole:"AXUserInterfaceTooltip"),"tooltip class ordering has no semantic effect")
  var missing = tooltipFixture; missing.remove(at:index)
  check(!viewerDownloadTooltip(missing,subrole:"AXUserInterfaceTooltip"),"partial tooltip or overlay structure is refused")
  var duplicate = tooltipFixture; duplicate.append(tooltipFixture[index])
  check(!viewerDownloadTooltip(duplicate,subrole:"AXUserInterfaceTooltip"),"mixed or duplicate tooltip descendants are refused")
}
for identifier in ["sk-tooltip-","sktooltip-1","sk-tooltip-1\n","prefix-sk-tooltip-1","sk-tooltip-"+String(repeating:"1",count:65),"sk-tooltip-foreign"] {
  var rows = tooltipFixture; rows[1]["id"] = identifier
  check(!viewerDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"tooltip identity uses only the bounded observed numeric form")
}

// Details uses a distinct, exact overlay layer. It never widens the image rule.
var detailsTooltipRows=downloadTooltipFixture()
detailsTooltipRows[0]["classes"]=(detailsTooltipRows[0]["classes"] as! [String]).map { $0 == "c-popover--z_menu" ? "c-popover--z_above_fs" : $0 }
check(fileDetailsDownloadTooltip(detailsTooltipRows,subrole:"AXUserInterfaceTooltip"),"exact details Download tooltip is recognized")
check(!viewerDownloadTooltip(detailsTooltipRows,subrole:"AXUserInterfaceTooltip"),"details overlay never changes the image tooltip predicate")
check(!fileDetailsDownloadTooltip(tooltipFixture,subrole:"AXUserInterfaceTooltip"),"image overlay never qualifies as the details tooltip")
for subrole in ["","AXDialog","AXApplicationDialog","AXUnknown"] {
  check(!fileDetailsDownloadTooltip(detailsTooltipRows,subrole:subrole),"details tooltip requires actual tooltip subrole")
}
for index in 0..<5 {
  for key in detailsTooltipRows[index].keys {
    var rows=detailsTooltipRows; rows[index].removeValue(forKey:key)
    check(!fileDetailsDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"partial details tooltip attributes fail closed")
  }
  for field in ["role","label","AXTitle","AXValue","AXDescription","AXHelp","index","parent","id","unknown"] {
    var rows=detailsTooltipRows;rows[index][field] = ["index","parent"].contains(field) ? 99 as Any : "foreign" as Any
    check(!fileDetailsDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"foreign details tooltip structure, content or metadata is refused")
  }
  let names=detailsTooltipRows[index]["classes"] as! [String]
  for name in names {
    var rows=detailsTooltipRows;rows[index]["classes"]=names.filter {$0 != name}
    check(!fileDetailsDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"details overlay and tooltip require every exact class")
  }
  for extra in ["unknown"]+Array(names.prefix(1)) {
    var rows=detailsTooltipRows;rows[index]["classes"]=names+[extra]
    check(!fileDetailsDownloadTooltip(rows,subrole:"AXUserInterfaceTooltip"),"unknown or duplicate details tooltip classes fail closed")
  }
  var duplicate=detailsTooltipRows;duplicate.append(detailsTooltipRows[index])
  check(!fileDetailsDownloadTooltip(duplicate,subrole:"AXUserInterfaceTooltip"),"duplicate details tooltip rows fail closed")
}

// Slack's persistent download notification uses ReactModal without being an
// interactive blocking dialog. Its narrow observed shape permits no toast input.
let toastClasses = ["ReactModal__Content", "ReactModal__Content--after-open", "c-toast", "c-toast--fade", "p-download_toast", "c-toast--download", "c-toast--persistent"]
let toastRows: [[String: Any]] = [
  ["index": 0, "parent": NSNull(), "role": "AXGroup", "label": "Recent downloads", "classes": toastClasses],
  ["index": 1, "parent": 0, "role": "AXGroup", "id": "toast-children", "classes": [String]()],
  ["index": 2, "parent": 1, "role": "AXGroup", "classes": ["p-download_toast_item", "c-pillow_file_container"]],
  ["index": 3, "parent": 2, "role": "AXLink", "label": "Open file", "classes": ["p-file_link_button--link"]],
  ["index": 4, "parent": 1, "role": "AXButton", "label": "View all downloads", "classes": ["p-download_controls__button"]],
  ["index": 5, "parent": 0, "role": "AXButton", "label": "Close", "classes": ["c-toast__close-button"]]
]
check(viewerDownloadToast(toastRows, subrole: "AXApplicationDialog"), "exact informational download toast does not become an unrelated viewer modal")
for name in toastClasses {
  var rows = toastRows; rows[0]["classes"] = toastClasses.filter { $0 != name }
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "missing observed toast identity class cannot bypass modal isolation")
}
for name in ["p-media_viewer_modal", "c-sk-modal", "unknown-modal", "p-composer"] {
  var rows = toastRows; rows[0]["classes"] = toastClasses + [name]
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "mixed unknown dialog or viewer classes cannot masquerade as a toast")
}
for (index, field, value) in [
  (0, "role", "AXDialog" as Any), (0, "role", "AXSheet" as Any), (0, "role", "AXMenu" as Any),
  (0, "label", "Download confirmation" as Any), (1, "id", "other-content" as Any),
  (1, "classes", ["unknown"] as Any), (1, "role", "AXButton" as Any),
  (5, "role", "AXLink" as Any), (5, "label", "Close viewer" as Any), (5, "classes", ["other-close"] as Any)
] {
  var rows = toastRows; rows[index][field] = value
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "toast role, title, content and close shape must remain exact")
}
for value in ["", "AXDialog", "AXSystemDialog"] {
  check(!viewerDownloadToast(toastRows, subrole: value), "unknown toast subrole never bypasses existing modal guards")
}
for role in ["AXDialog", "AXSheet", "AXMenu", "AXTextField", "AXTextArea"] {
  var rows = toastRows; rows.append(["index": 6, "parent": 1, "role": role, "classes": [String]()])
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "blocking or editable descendants invalidate notification exception")
}
for name in ["ReactModal__Content", "p-media_viewer_modal", "p-media_viewer_modal__multimedia", "c-sk-modal", "p-file_viewer"] {
  var rows = toastRows; rows.append(["index": 6, "parent": 1, "role": "AXGroup", "classes": [name]])
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "nested modal and file viewers cannot hide under the toast exception")
}
for index in [1, 5] {
  var rows = toastRows; rows.remove(at: index)
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "missing expected toast child fails closed")
  rows = toastRows; var duplicate = rows[index]; duplicate["index"] = 6; rows.append(duplicate)
  check(!viewerDownloadToast(rows, subrole: "AXApplicationDialog"), "duplicate toast child fails closed")
}

// The independently observed transient toast contains one active download card
// and its controls, without the persistent toast's root-level Close button.
let transientToastClasses = [
  ["ReactModal__Content","ReactModal__Content--after-open","c-toast","c-toast--fade","p-download_toast","c-toast--download"],
  [],
  ["c-pillow_file_container","c-pillow_file_container--download","p-download_toast_item","p-download_toast_item--last-item","c-pillow_file_container--full_width","c-pillow_file_container--active_download"],
  ["c-link","c-button-unstyled","p-file_link_button--link","c-pillow_file","c-pillow_file--full_width","c-pillow_file--active_download","c-pillow_file--clickable"],
  ["p-file_thumbnail__container","p-file_thumbnail__container--other","c-file_entity_thumbnail_icon","c-base_entity__avatar"],
  [], ["c-pillow_file__size","c-pillow_file__meta__entry"], ["c-pillow_file__swap"], [],
  ["p-download_controls__actions"], ["c-button-unstyled","p-download_controls__button"], ["c-button-unstyled","p-download_controls__button"]
]
let transientToastParents: [Any] = [NSNull(),0,1,2,3,3,3,6,7,1,9,9]
let transientToastRoles = ["AXGroup","AXGroup","AXGroup","AXLink","AXGroup","AXStaticText","AXGroup","AXGroup","AXStaticText","AXGroup","AXButton","AXButton"]
let transientToastRows:[[String:Any]] = (0..<12).map { index in
  var row:[String:Any] = ["index":index,"parent":transientToastParents[index]]
  row["role"]=transientToastRoles[index]; row["classes"]=transientToastClasses[index]
  row["id"]=index == 1 ? "toast-children" : ""
  row["label"]=index == 0 ? "Recent downloads" : "synthetic presentation"
  row["AXTitle"]=index == 0 ? "Recent downloads" : ""
  return row
}
for index in transientToastRows.indices {
  for (field,value) in [("role","AXDialog" as Any),("parent",99 as Any),("index",99 as Any),("id","foreign" as Any)] {
    var rows=transientToastRows;rows[index][field]=value
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"transient toast requires every exact role, index, parent and identifier")
  }
  for name in transientToastClasses[index] {
    var rows=transientToastRows;rows[index]["classes"]=transientToastClasses[index].filter { $0 != name }
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"transient toast requires every observed identity class")
  }
  for extra in ["foreign"]+Array(transientToastClasses[index].prefix(1)) {
    var rows=transientToastRows;rows[index]["classes"]=transientToastClasses[index]+[extra]
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"unknown or duplicated transient toast classes cannot bypass isolation")
  }
  var missing=transientToastRows;missing.remove(at:index)
  check(!viewerDownloadToast(missing,subrole:"AXApplicationDialog"),"partial transient toast shape is refused")
  check(!viewerDownloadToast(transientToastRows+[transientToastRows[index]],subrole:"AXApplicationDialog"),"duplicated transient toast nodes are refused")
}
for role in ["AXDialog","AXSheet","AXMenu","AXTextField","AXTextArea"] {
  check(!viewerDownloadToast(transientToastRows+[["index":12,"parent":1,"role":role,"classes":[],"id":""]],subrole:"AXApplicationDialog"),"nested blocking or editable content is never hidden by transient toast recognition")
}
for name in ["ReactModal__Content","p-media_viewer_modal","p-media_viewer_modal__multimedia","c-sk-modal","p-file_viewer"] {
  check(!viewerDownloadToast(transientToastRows+[["index":12,"parent":1,"role":"AXGroup","classes":[name],"id":""]],subrole:"AXApplicationDialog"),"nested modal and file viewers invalidate transient toast recognition")
}
for subrole in ["","AXDialog","AXSystemDialog"] {
  check(!viewerDownloadToast(transientToastRows,subrole:subrole),"transient toast requires the observed application-dialog subrole")
}
for label in ["","Download confirmation","Recent downloads "] {
  var rows=transientToastRows;rows[0]["label"]=label
  check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"transient toast requires the exact root label")
}
var mixedTransientToast=transientToastRows;mixedTransientToast[0]["classes"]=toastClasses
check(!viewerDownloadToast(mixedTransientToast,subrole:"AXApplicationDialog"),"persistent and transient toast layouts cannot be mixed")
mixedTransientToast=transientToastRows;mixedTransientToast[0].removeValue(forKey:"AXTitle")
check(!viewerDownloadToast(mixedTransientToast,subrole:"AXApplicationDialog"),"transient toast title must corroborate its exact label")
check(viewerDownloadToast(transientToastRows,subrole:"AXApplicationDialog"),"observed twelve-node transient active-download toast is informational without a root Close")
let reorderedTransientToast=transientToastRows.map { row in var value=row;value["classes"]=Array((row["classes"] as! [String]).reversed());return value }
check(viewerDownloadToast(reorderedTransientToast,subrole:"AXApplicationDialog"),"exact transient class sets preserve identity independently of class order")
var transientSizeToastRows=transientToastRows.enumerated().map { index,row -> [String:Any] in
  var shifted=row
  if index >= 9 { shifted["index"]=index+1 }
  if let parent=row["parent"] as? Int, parent >= 9 { shifted["parent"]=parent+1 }
  return shifted
}
transientSizeToastRows.insert(["index":9,"parent":7,"role":"AXStaticText","classes":[String](),"id":"","label":"synthetic size suffix"],at:9)
for index in transientSizeToastRows.indices {
  for (field,value) in [("role","AXDialog" as Any),("parent",99 as Any),("index",99 as Any),("id","foreign" as Any)] {
    var rows=transientSizeToastRows;rows[index][field]=value
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"size-suffix toast requires every exact role, index, parent and identifier")
  }
  let names=transientSizeToastRows[index]["classes"] as! [String]
  for name in names {
    var rows=transientSizeToastRows;rows[index]["classes"]=names.filter { $0 != name }
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"size-suffix toast requires every observed identity class")
  }
  for extra in ["foreign"]+Array(names.prefix(1)) {
    var rows=transientSizeToastRows;rows[index]["classes"]=names+[extra]
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"unknown or duplicate size-suffix toast classes are refused")
  }
  var missing=transientSizeToastRows;missing.remove(at:index)
  check(!viewerDownloadToast(missing,subrole:"AXApplicationDialog"),"partial size-suffix toast rows cannot authorize isolation")
  check(!viewerDownloadToast(transientSizeToastRows+[transientSizeToastRows[index]],subrole:"AXApplicationDialog"),"duplicated size-suffix toast rows cannot authorize isolation")
}
for subrole in ["","AXDialog","AXSystemDialog"] {
  check(!viewerDownloadToast(transientSizeToastRows,subrole:subrole),"size-suffix toast keeps its exact application-dialog subrole")
}
for label in ["","Download confirmation","Recent downloads "] {
  var rows=transientSizeToastRows;rows[0]["label"]=label
  check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"size-suffix toast keeps its exact root label")
}
check(!viewerDownloadToast(transientSizeToastRows+[["index":13,"parent":7,"role":"AXTextArea","classes":[],"id":""]],subrole:"AXApplicationDialog"),"a third status child or nested editor is not an observed size-suffix layout")
check(viewerDownloadToast(transientSizeToastRows,subrole:"AXApplicationDialog"),"observed thirteen-node transient toast permits the second empty-class size text child")
let reorderedSizeToast=transientSizeToastRows.map { row in var value=row;value["classes"]=Array((row["classes"] as! [String]).reversed());return value }
check(viewerDownloadToast(reorderedSizeToast,subrole:"AXApplicationDialog"),"size-suffix class inventories are exact sets independently of order")
var completedToastRows=Array(transientToastRows.prefix(9))
completedToastRows[2]["classes"]=(completedToastRows[2]["classes"] as! [String])+["p-download_toast_item--completed","p-download_toast_item--other-completed"]
completedToastRows += [
  ["index":9,"parent":7,"role":"AXGroup","id":"","classes":["c-pillow_file__slide","c-pillow_file__size__action"]],
  ["index":10,"parent":9,"role":"AXStaticText","id":"","classes":[String](),"label":"synthetic completion status"],
  ["index":11,"parent":1,"role":"AXGroup","id":"","classes":["p-download_controls__viewall"]],
  ["index":12,"parent":11,"role":"AXButton","id":"","classes":["c-button-unstyled","p-download_controls__button"]]
]
for index in completedToastRows.indices {
  for (field,value) in [("role","AXDialog" as Any),("parent",99 as Any),("index",99 as Any),("id","foreign" as Any)] {
    var rows=completedToastRows;rows[index][field]=value
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"completed toast requires every exact role, index, parent and identifier")
  }
  let names=completedToastRows[index]["classes"] as! [String]
  for name in names {
    var rows=completedToastRows;rows[index]["classes"]=names.filter { $0 != name }
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"completed toast requires every lifecycle and identity class")
  }
  for extra in ["foreign"]+Array(names.prefix(1)) {
    var rows=completedToastRows;rows[index]["classes"]=names+[extra]
    check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"unknown or duplicate completed toast classes cannot bypass isolation")
  }
  var missing=completedToastRows;missing.remove(at:index)
  check(!viewerDownloadToast(missing,subrole:"AXApplicationDialog"),"partial completed toast rows cannot authorize isolation")
  check(!viewerDownloadToast(completedToastRows+[completedToastRows[index]],subrole:"AXApplicationDialog"),"duplicate completed toast rows cannot authorize isolation")
}
for subrole in ["","AXDialog","AXSystemDialog"] {
  check(!viewerDownloadToast(completedToastRows,subrole:subrole),"completed toast keeps its exact application-dialog subrole")
}
for label in ["","Download confirmation","Recent downloads "] {
  var rows=completedToastRows;rows[0]["label"]=label
  check(!viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"completed toast keeps its exact root label")
}
check(!viewerDownloadToast(completedToastRows+[["index":13,"parent":9,"role":"AXTextArea","classes":[],"id":""]],subrole:"AXApplicationDialog"),"completed toast cannot contain an extra editor or status child")
var mixedCompletedToast=transientToastRows;mixedCompletedToast[2]["classes"]=completedToastRows[2]["classes"]
check(!viewerDownloadToast(mixedCompletedToast,subrole:"AXApplicationDialog"),"completion classes cannot be combined with an active-download control layout")
check(viewerDownloadToast(completedToastRows,subrole:"AXApplicationDialog"),"observed completed-download toast accepts only its exact thirteen-node lifecycle layout")
let reorderedCompletedToast=completedToastRows.map { row in var value=row;value["classes"]=Array((row["classes"] as! [String]).reversed());return value }
check(viewerDownloadToast(reorderedCompletedToast,subrole:"AXApplicationDialog"),"completed class inventories are exact sets independently of order")
do {
  let pins=Dictionary(uniqueKeysWithValues:(0..<13).map { ($0,$0) })
  let nodes=completedToastRows.enumerated().map { index,row in ViewerToastStructuralNode(element:index,parent:row["parent"] as? Int,role:row["role"] as! String,classes:row["classes"] as! [String]) }
  func accepted(_ observed:[ViewerToastStructuralNode<Int>]) -> Bool { viewerToastCaptureAccepted(completedToastRows,subrole:"AXApplicationDialog",captured:pins,structural:observed,same:==) }
  check(accepted(nodes),"completed toast requires all thirteen matching live structural identities")
  check(!accepted(Array(nodes.dropLast())),"missing live completed-toast identity is refused")
  check(!accepted(nodes+[ViewerToastStructuralNode(element:13,parent:9,role:"AXTextArea",classes:[])]),"completed toast cannot hide an editor omitted by content snapshots")
  var changed=nodes;changed[10]=ViewerToastStructuralNode(element:10,parent:7,role:"AXStaticText",classes:[])
  check(!accepted(changed),"completion text must retain its slide-action parent")
  changed=nodes;changed[10]=ViewerToastStructuralNode(element:10,parent:9,role:"AXTextArea",classes:[])
  check(!accepted(changed),"completion text cannot become an editor before structural verification")
}
do {
  let pins=Dictionary(uniqueKeysWithValues:(0..<13).map { ($0,$0) })
  let nodes=transientSizeToastRows.enumerated().map { index,row in ViewerToastStructuralNode(element:index,parent:row["parent"] as? Int,role:row["role"] as! String,classes:row["classes"] as! [String]) }
  func accepted(_ observed:[ViewerToastStructuralNode<Int>]) -> Bool { viewerToastCaptureAccepted(transientSizeToastRows,subrole:"AXApplicationDialog",captured:pins,structural:observed,same:==) }
  check(accepted(nodes),"thirteen captured nodes still require thirteen matching complete structural identities")
  check(!accepted(Array(nodes.dropLast())),"missing live size-suffix toast identity is refused")
  check(!accepted(nodes+[ViewerToastStructuralNode(element:13,parent:7,role:"AXTextArea",classes:[])]),"redacted extra editor cannot hide behind the size-suffix variant")
  var changed=nodes;changed[9]=ViewerToastStructuralNode(element:9,parent:6,role:"AXStaticText",classes:[])
  check(!accepted(changed),"size suffix must retain the same swap-container parent")
  changed=nodes;changed[9]=ViewerToastStructuralNode(element:9,parent:7,role:"AXTextArea",classes:[])
  check(!accepted(changed),"size suffix cannot become an editor between capture and structural proof")
}
do {
  let handles=(0..<13).map { AXUIElementCreateApplication(pid_t(700_000+$0)) }
  func index(_ element:AXUIElement) -> Int { handles.firstIndex { CFEqual($0,element) }! }
  var captured:[Int:AXUIElement]=[:]
  var editorRead=false
  let snapshot=try contentSnapshot(handles[0],onNode:{ captured[$0]=$1 },readRow:{ element,newIndex,parent in
    let oldIndex=index(element)
    if oldIndex == 12 { editorRead=true; return [:] }
    var row=transientToastRows[oldIndex];row["index"]=newIndex;row["parent"]=parent as Any? ?? NSNull();return row
  },children:{ element in
    let parent=index(element)
    let known=(1..<12).filter { transientToastParents[$0] as? Int == parent }.map { handles[$0] }
    return parent == 1 ? known+[handles[12]] : known
  },liveRole:{ element in index(element) == 12 ? "AXTextArea" : transientToastRoles[index(element)] })
  let rows=snapshot["nodes"] as! [[String:Any]]
  check(rows.count == 12 && captured.count == 12 && !editorRead,"real contentSnapshot omits the injected editor row/content and does not call readRow for it")
  check(viewerDownloadToast(rows,subrole:"AXApplicationDialog"),"redacted rows alone cannot establish complete transient toast structure")
  let structural=(0..<13).map { item -> ViewerToastStructuralNode<AXUIElement> in
    let parent=item == 12 ? 1 : transientToastParents[item] as? Int
    return ViewerToastStructuralNode(element:handles[item],parent:parent.map { handles[$0] },role:item == 12 ? "AXTextArea" : transientToastRoles[item],classes:item == 12 ? [] : transientToastClasses[item])
  }
  check(!viewerToastCaptureAccepted(rows,subrole:"AXApplicationDialog",captured:captured,structural:structural,same:CFEqual),"fresh complete structural inventory must reject an editor omitted by contentSnapshot")
}
do {
  let captured=Dictionary(uniqueKeysWithValues:(0..<12).map { ($0,$0) })
  let nodes=(0..<12).map { ViewerToastStructuralNode(element:$0,parent:transientToastParents[$0] as? Int,role:transientToastRoles[$0],classes:transientToastClasses[$0]) }
  func accepted(_ pins:[Int:Int],_ observed:[ViewerToastStructuralNode<Int>]) -> Bool {
    viewerToastCaptureAccepted(transientToastRows,subrole:"AXApplicationDialog",captured:pins,structural:observed,same:==)
  }
  check(accepted(captured,nodes),"complete matching structural identities authorize the exact transient capture")
  check(accepted(captured,Array(nodes.reversed())),"structural walk order may differ while identities and parent links stay exact")
  check(viewerToastCaptureAccepted(toastRows,subrole:"AXApplicationDialog",captured:[Int:Int](),structural:[],same:==),"legacy persistent toast behavior is unchanged")
  for mutation in 0..<12 {
    var pins=captured;var observed=nodes
    switch mutation {
    case 0: pins.removeValue(forKey:11)
    case 1: observed.removeLast()
    case 2: observed.append(ViewerToastStructuralNode(element:12,parent:1,role:"AXTextArea",classes:[]))
    case 3: pins[11]=10
    case 4: observed[11]=observed[10]
    case 5: observed[11]=ViewerToastStructuralNode(element:99,parent:9,role:"AXButton",classes:transientToastClasses[11])
    case 6: observed[0]=ViewerToastStructuralNode(element:0,parent:99,role:transientToastRoles[0],classes:transientToastClasses[0])
    case 7: observed[11]=ViewerToastStructuralNode(element:11,parent:0,role:"AXButton",classes:transientToastClasses[11])
    case 8: observed[11]=ViewerToastStructuralNode(element:11,parent:9,role:"AXTextArea",classes:transientToastClasses[11])
    case 9: observed[11]=ViewerToastStructuralNode(element:11,parent:9,role:"AXButton",classes:[])
    case 10: observed[11]=ViewerToastStructuralNode(element:11,parent:9,role:"AXButton",classes:transientToastClasses[11]+[transientToastClasses[11][0]])
    default: observed[11]=ViewerToastStructuralNode(element:11,parent:9,role:"AXButton",classes:[transientToastClasses[11][0],"foreign"])
    }
    check(!accepted(pins,observed),"missing, extra, aliased, reparented or structurally changed live nodes invalidate a redacted transient capture")
  }
}

// Retained AX identity checks use inert synthetic process handles, never live UI.
let detailsPage = "https://example.slack.com/files/UDEMO/FFILE/demo.pdf"
for url in [detailsPage, detailsPage + "?origin_team=TDEMO", detailsPage + "?origin_team=EDEMO"] {
  check(detailsFilePageID(url, contextId: url.contains("EDEMO") ? "EDEMO" : "TDEMO") == "FFILE", "canonical observed file page retains its file identity")
}
for url in [detailsPage + "?extra=1", detailsPage + "?origin_team=TOTHER", detailsPage + "#fragment", detailsPage + "/extra", detailsPage + "\n", detailsPage.replacingOccurrences(of: "demo.pdf", with: "%2E%2E"), detailsPage.replacingOccurrences(of: "demo.pdf", with: "%2Funsafe"), "https://slack.com.evil/files/UDEMO/FFILE/demo.pdf", "https://user@example.slack.com/files/UDEMO/FFILE/demo.pdf"] {
  check(detailsFilePageID(url, contextId: "TDEMO") == nil, "unknown or contradictory file-page syntax cannot authorize details")
}
func detailsSourceFixture(_ audio: Bool = false) -> [[String: Any]] {
  var rows: [[String: Any]] = [
    ["index": 0, "parent": NSNull(), "role": "AXGroup", "classes": ["c-message_kit__actions"]],
    ["index": 1, "parent": 0, "role": "AXGroup", "classes": audio ? ["c-pillow_file_container", "p-search_file--audio-player"] : ["c-pillow_file_container", "p-message_file"]],
    ["index": 2, "parent": 1, "role": "AXLink", "classes": ["p-file_link_button--link"], "url": detailsPage],
    ["index": 3, "parent": 1, "role": "AXGroup", "classes": ["c-file__actions", "c-message_actions__container", "c-message_actions__group"]],
    ["index": 4, "parent": 3, "role": "AXButton", "classes": ["c-message_actions__button"], "label": "View file details"]
  ]
  if audio {
    rows[2] = ["index": 2, "parent": 1, "role": "AXGroup", "classes": ["sr-only"], "id": "transcript-description-FFILE"]
    rows.append(["index": 5, "parent": 1, "role": "AXCheckBox", "classes": ["c-audio_player_play_button"], "label": "Play", "stateValue": "0"])
  }
  return rows
}
let detailsOpeners = fileDetailsOpenerTargets(detailsSourceFixture(), contextId: "TDEMO")
check(detailsOpeners.count == 1 && detailsOpeners[0].filePageURL == detailsPage && detailsOpeners[0].filePageIndex == 2 && detailsOpeners[0].mediaKind == "file", "document details is bound to original source, button and observed file page")
let audioDetailsOpeners = fileDetailsOpenerTargets(detailsSourceFixture(true), contextId: "TDEMO")
check(audioDetailsOpeners.count == 1 && audioDetailsOpeners[0].filePageURL == nil && audioDetailsOpeners[0].filePageIndex == nil && audioDetailsOpeners[0].mediaKind == "audio", "known audio transcript ID permits details without inventing a file page")
let nativeAudioClasses=["c-pillow_file_container","c-file_gallery__message_file","p-message_file","p-message_file--media","p-message_file--audio_message","p-message_file--show_preview"]
var nativeAudioSource=detailsSourceFixture(true);nativeAudioSource[1]["classes"]=nativeAudioClasses
let nativeAudioOpeners=fileDetailsOpenerTargets(nativeAudioSource,contextId:"TDEMO")
check(detailsMediaKind(nativeAudioSource[1]) == "audio" && detailsAudioRoot(nativeAudioSource[1]),"fresh native thread audio classes agree on audio kind and canonical identity root")
check(nativeAudioOpeners.count == 1 && nativeAudioOpeners[0].mediaKind == "audio" && nativeAudioOpeners[0].filePageURL == nil,"native audio with an explicit Details control uses its owned canonical ID without inventing a page")
let nativeAudioRequiresPlayback=nativeAudioOpeners[0].mediaKind != "file"
check(!downloadPlaybackIdle([],required:nativeAudioRequiresPlayback),"native source classification makes known playback controls mandatory")
check(downloadPlaybackIdle([["label":"Play","value":"0"]],required:nativeAudioRequiresPlayback),"native source idle state must be explicitly zero")
for value in ["1" as Any,NSNull(),false as Any] {
  check(!downloadPlaybackIdle([["label":"Play","value":value]],required:nativeAudioRequiresPlayback),"active or unknown native audio playback cannot be treated as idle")
}
var nativeAudioWithPage=nativeAudioSource
nativeAudioWithPage.append(["index":6,"parent":1,"role":"AXLink","classes":["p-file_link_button--link"],"url":detailsPage])
let nativeAudioPageOpeners=fileDetailsOpenerTargets(nativeAudioWithPage,contextId:"TDEMO")
check(nativeAudioPageOpeners.count == 1 && nativeAudioPageOpeners[0].mediaKind == "audio" && nativeAudioPageOpeners[0].filePageURL == detailsPage,"an observed native audio page preserves audio playback requirements")
check(fileDetailsOpenerTargets(nativeAudioSource.filter {$0["index"] as? Int != 4},contextId:"TDEMO").isEmpty,"the fresh native card without a Details control gains no action capability")
for marker in ["c-pillow_file_container","p-message_file","p-message_file--audio_message"] {
  var rows=nativeAudioSource;rows[1]["classes"]=nativeAudioClasses.filter {$0 != marker}
  check(detailsMediaKind(rows[1]) != "audio" && fileDetailsOpenerTargets(rows,contextId:"TDEMO").isEmpty,"every native audio identity class is required before an absent-page fallback")
}
for (index,field,value) in [(1,"role","AXButton" as Any),(2,"id","transcript-description-FFILE\n" as Any),(2,"classes",["unknown"] as Any),(2,"parent",0 as Any),(5,"role","AXButton" as Any),(5,"classes",["unknown"] as Any),(5,"parent",0 as Any),(4,"parent",0 as Any)] {
  var rows=nativeAudioSource;rows[index][field]=value
  check(fileDetailsOpenerTargets(rows,contextId:"TDEMO").isEmpty,"native audio retains exact role, owned transcript identity, Play control and Details ancestry")
}
for removed in [2,5] {
  check(fileDetailsOpenerTargets(nativeAudioSource.filter {$0["index"] as? Int != removed},contextId:"TDEMO").isEmpty,"native audio cannot infer a missing canonical ID or playback control")
}
var contradictoryNativeAudio=nativeAudioWithPage;contradictoryNativeAudio[6]["url"]="https://demo.slack.com/files/UDEMO/FOTHER/demo.m4a"
check(fileDetailsOpenerTargets(contradictoryNativeAudio,contextId:"TDEMO").isEmpty,"native audio page and canonical transcript ID must agree")
var nativeAudioDownload=nativeAudioSource;nativeAudioDownload.append(["index":6,"parent":1,"role":"AXButton","classes":[String](),"label":"Download","enabled":false])
check(fileDetailsOpenerTargets(nativeAudioDownload,contextId:"TDEMO").isEmpty,"even a disabled native source Download prevents fallback selection")
for owner in ["p-composer","p-message_input","p-media_viewer_modal","p-view_contents--secondary"] {
  var rows=nativeAudioSource;rows[0]["classes"]=["c-message_kit__actions",owner]
  check(fileDetailsOpenerTargets(rows,contextId:"TDEMO").isEmpty,"native source classification cannot authorize a composer or viewer clone")
}
for rootName in ["p-composer", "p-message_input", "p-media_viewer_modal", "p-view_contents--secondary"] {
  var rows = detailsSourceFixture(); rows[0]["classes"] = ["c-message_kit__actions", rootName]
  check(fileDetailsOpenerTargets(rows, contextId: "TDEMO").isEmpty, "a clone or editable source cannot supply a details opener")
}
for role in ["AXLink", "AXButton", "AXMenuItem", "AXPopUpButton"] {
  var rows = detailsSourceFixture(); rows.append(["index": 9, "parent": 1, "role": role, "classes": [String](), "label": "Download", "enabled": false])
  check(fileDetailsOpenerTargets(rows, contextId: "TDEMO").isEmpty, "any source-owned Download inventory prevents details fallback")
}
for (index, field, value) in [(4,"label","Play" as Any),(4,"role","AXLink" as Any),(4,"classes",["other"] as Any),(4,"parent",0 as Any),(3,"classes",["c-file__actions"] as Any),(2,"url",detailsPage + "?unknown=1" as Any)] {
  var rows = detailsSourceFixture();rows[index][field] = value
  check(fileDetailsOpenerTargets(rows, contextId: "TDEMO").isEmpty, "details source opener ancestry and exact roles are required")
}
for index in [2,3,4] {
  var rows = detailsSourceFixture(); rows.remove(at:index)
  check(fileDetailsOpenerTargets(rows, contextId: "TDEMO").isEmpty, "missing source binding element withholds details")
}
for (index, field, value) in [(2,"role","AXStaticText" as Any),(2,"classes",["unknown"] as Any),(2,"id","transcript-description-FFILE-unknown" as Any),(5,"role","AXButton" as Any),(5,"classes",["unknown-player"] as Any),(1,"classes",["p-search_file--audio-player"] as Any)] {
  var rows = detailsSourceFixture(true);rows[index][field] = value
  check(fileDetailsOpenerTargets(rows, contextId: "TDEMO").isEmpty, "audio identity requires known source root, own Play checkbox and exact sr-only description")
}
var conflictingAudioDetails = detailsSourceFixture(true)
conflictingAudioDetails.append(["index": 6, "parent": 1, "role": "AXLink", "classes": [String](), "url": detailsPage.replacingOccurrences(of:"FFILE",with:"FOTHER")])
check(fileDetailsOpenerTargets(conflictingAudioDetails, contextId: "TDEMO").isEmpty, "conflicting audio URL and transcript identities withhold details")
func detailsPaneFixture(_ audio: Bool = false) -> [[String: Any]] {
  var rows: [[String: Any]] = [
    ["index":0,"parent":NSNull(),"role":"AXGroup","classes":["p-view_contents","p-view_contents--secondary"]],
    ["index":1,"parent":0,"role":"AXToolbar","classes":["p-flexpane_header"]],
    ["index":2,"parent":1,"role":"AXButton","classes":["p-flexpane_header__control"],"label":"Close"],
    ["index":3,"parent":0,"role":"AXGroup","classes":["p-flexpane__body"]],
    ["index":4,"parent":3,"role":"AXGroup","classes":["c-pillow_file_container","p-message_file","p-message_file--show_preview"]],
    ["index":5,"parent":4,"role":"AXLink","classes":["p-file_link_button--link"],"url":detailsPage],
    ["index":6,"parent":0,"role":"AXGroup","classes":["c-file__actions","p-file_details__references_footer"]],
    ["index":7,"parent":6,"role":"AXLink","classes":["p-file_details__references_actions"],"label":"Download demo.pdf","url":"https://files.slack.com/files-pri/TDEMO-FFILE/download/demo.pdf"]
  ]
  if audio {
    rows[4]["classes"] = ["c-pillow_file_container","p-message_file","p-message_file--media","p-message_file--audio_message","p-message_file--show_preview"]
    rows[5] = ["index":5,"parent":4,"role":"AXGroup","classes":["sr-only"],"id":"transcript-description-FFILE"]
    rows[7]["url"] = "https://files.slack.com/files-tmb/TDEMO-FFILE/audio.mp4"
    rows.append(["index":8,"parent":4,"role":"AXCheckBox","classes":["c-audio_player_play_button"],"label":"Play","stateValue":"0"])
  }
  return rows
}
func detailTarget(_ rows: [[String:Any]], _ audio: Bool = false) -> FileDetailsDownloadTarget? {
  fileDetailsDownloadTarget(rows, fileId:"FFILE", sourceFilePageURL:audio ? nil : detailsPage, contextId:"TDEMO")
}
let documentDetailsTarget = detailTarget(detailsPaneFixture())!
check(documentDetailsTarget.paneIndex == 0 && documentDetailsTarget.cardIndex == 4 && documentDetailsTarget.fileLinkIndex == 5 && documentDetailsTarget.identityIndex == 5 && documentDetailsTarget.footerIndex == 6 && documentDetailsTarget.controlIndex == 7 && documentDetailsTarget.closeIndex == 2, "document pane binds actual page, scoped Download and scoped Close")
check(documentDetailsTarget.routeKind == "file-download" && documentDetailsTarget.filePageURL == detailsPage && !documentDetailsTarget.playbackRequired, "document pane reports an observed file-content route without inventing playback")
let audioDetailsTarget = detailTarget(detailsPaneFixture(true), true)!
check(audioDetailsTarget.fileLinkIndex == nil && audioDetailsTarget.filePageURL == nil && audioDetailsTarget.identityIndex == 5 && audioDetailsTarget.routeKind == "rendition" && audioDetailsTarget.playbackRequired, "audio pane uses own transcript identity and actual rendition Download without guessed page")
for index in 0...7 {
  var rows = detailsPaneFixture(); rows[index]["role"] = "AXUnknown"
  check(detailTarget(rows) == nil, "each details pane structural role is required")
  rows = detailsPaneFixture(); rows.remove(at:index)
  check(detailTarget(rows) == nil, "missing details component cannot retain Download permission")
}
for index in [1,2,3,4,5,6,7] {
  var rows = detailsPaneFixture(); rows[index]["parent"] = 99
  check(detailTarget(rows) == nil, "moving a details control outside its scope invalidates binding")
}
for index in [0,1,2,3,4,5,6,7] {
  var rows = detailsPaneFixture(), duplicate = rows[index]; duplicate["index"] = 20
  rows.append(duplicate)
  check(detailTarget(rows) == nil, "duplicate details identity or control cannot be guessed")
}
for (index,field,value) in [(5,"url",detailsPage.replacingOccurrences(of:"FFILE",with:"FOTHER") as Any),(5,"url",detailsPage + "?origin_team=TDEMO" as Any),(7,"url","https://files.slack.com/files-pri/TDEMO-FOTHER/download/demo.pdf" as Any),(7,"url","https://foreign.example/demo.pdf" as Any),(7,"label","Download all" as Any),(7,"classes",["other-actions"] as Any),(2,"label","Close something else" as Any),(2,"classes",["other-close"] as Any)] {
  var rows = detailsPaneFixture(); rows[index][field] = value
  check(detailTarget(rows) == nil, "changed pane identity, exact source URL or scoped actions revoke Download")
}
for role in ["AXTextArea","AXTextField","AXDialog","AXSheet","AXMenu"] {
  var rows = detailsPaneFixture(); rows.append(["index":9,"parent":4,"role":role,"classes":[String]()])
  check(detailTarget(rows) == nil, "blocking or editable active card cannot supply Download")
}
var buttonPlayerDetails = detailsPaneFixture();buttonPlayerDetails.append(["index":9,"parent":4,"role":"AXButton","classes":[String](),"label":"Play"])
check(detailTarget(buttonPlayerDetails) == nil, "unknown button-based playback cannot be treated as an idle details card")
for (index,field,value) in [(5,"id","transcript-description-FOTHER" as Any),(5,"classes",["unknown"] as Any),(8,"role","AXButton" as Any),(8,"classes",["unknown-player"] as Any)] {
  var rows = detailsPaneFixture(true);rows[index][field] = value
  check(detailTarget(rows,true) == nil, "audio pane identity requires exact known audio description/player shape")
}
let detailsHandles = (0..<12).map { AXUIElementCreateApplication(pid_t(720000 + $0)) }
func detailsFullObservation(
  paneRows:[[String:Any]] = detailsPaneFixture(), sourceRows:[[String:Any]] = detailsSourceFixture(),
  sourceFilePageIndex:Int? = 2, sourcePlayback:[[String:Any]] = [], viewerPlayback:[[String:Any]] = []
) -> [String:Any] {
  let view:[String:Any] = ["url":"https://app.slack.com/client/TDEMO/CDEMO","title":"Fixture channel - Slack"]
  return [
    "before":view,"after":view,"content":["truncated":false,"nodes":paneRows],
    "source":["content":["truncated":false,"nodes":sourceRows],"mediaIndex":1,"controlIndex":4,"filePageIndex":sourceFilePageIndex as Any? ?? NSNull(),"playback":sourcePlayback],
    "detailsPlayback":["source":sourcePlayback,"viewer":viewerPlayback]
  ]
}
let detailsFullCaptureObservation=detailsFullObservation()
let retainedDetailsOpener = FileDetailsOpenerCandidate(token:"details-opener",target:detailsOpeners[0],container:detailsHandles[8],media:detailsHandles[9],control:detailsHandles[10],filePage:detailsHandles[11],signature:try transcriptSourceSignature(detailsSourceFixture(),0,selectedMediaIndex:1),videoPins:TranscriptVideoPins(),playback:[])
let retainedDetails = FileDetailsDownloadCandidate(token:"details-download",opener:retainedDetailsOpener,pane:detailsHandles[0],card:detailsHandles[4],identityElement:detailsHandles[5],footer:detailsHandles[6],control:detailsHandles[7],close:detailsHandles[2],target:documentDetailsTarget,viewerPlayback:[])
let detailsElements = Dictionary(uniqueKeysWithValues:(0...7).map { ($0,detailsHandles[$0]) })
let detailsCapture = FileDetailsDownloadCapture(observation:detailsFullCaptureObservation,target:documentDetailsTarget,elements:detailsElements,sourcePlayback:[],viewerPlayback:[])
try retainedDetails.verify(detailsCapture)
check(true,"unchanged retained details elements preserve selection")
for index in [0,2,4,5,6,7] {
  var elements = detailsElements;elements[index] = detailsHandles[9]
  do { try retainedDetails.verify(FileDetailsDownloadCapture(observation:detailsFullCaptureObservation,target:documentDetailsTarget,elements:elements,sourcePlayback:[],viewerPlayback:[]));fatalError("replaced details element accepted") }
  catch { check(error is Failure,"every retained pane/card/identity/footer/Download/Close element is checked") }
}
do { try retainedDetails.verify(FileDetailsDownloadCapture(observation:detailsFullCaptureObservation,target:documentDetailsTarget,elements:detailsElements,sourcePlayback:[],viewerPlayback:[["label":"Pause","value":"1"]]));fatalError("changed details playback accepted") }
catch { check(error is Failure,"viewer playback changes invalidate the retained details selection") }
check(retainedDetails.receipt["scope"] as? String == "file-details" && retainedDetails.receipt["url"] as? String == documentDetailsTarget.url && retainedDetailsOpener.receipt["scope"] as? String == "file-details-opener","details capability preserves explicit opener and actual Download URL")

// Post-download tooltip proof uses the same retained selection checks as Download.
let tooltipPaneCapture=FileDetailsPaneCapture(content:[:],target:documentDetailsTarget,elements:detailsElements,playback:[])
var tooltipStages=[String]()
try verifyFileDetailsTooltipOwner(retainedDetails,panes:{tooltipStages.append("panes");return [retainedDetails.pane]},source:{tooltipStages.append("source")},capture:{tooltipStages.append("capture");return tooltipPaneCapture},focused:{control in tooltipStages.append("focus");return CFEqual(control,retainedDetails.control)})
check(tooltipStages == ["panes","source","capture","panes","focus"],"source and retained pane/Download are freshly proven before accepting details tooltip")
for focus:Bool? in [false,nil] {
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{},capture:{tooltipPaneCapture},focused:{_ in focus});fatalError("unfocused details Download authorized tooltip")}
  catch {check(error is Failure,"false or unknown Download focus cannot authorize tooltip")}
}
for panes in [[AXUIElement](),[detailsHandles[9]],[retainedDetails.pane,retainedDetails.pane],[retainedDetails.pane,detailsHandles[9]]] {
  var sourceCalls=0
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{panes},source:{sourceCalls += 1},capture:{tooltipPaneCapture},focused:{_ in true});fatalError("foreign or ambiguous pane authorized tooltip")}
  catch {check(error is Failure && sourceCalls == 0,"missing, replaced or duplicate pane fails before source proof")}
}
do {
  var paneReads=0;var focusReads=0
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{paneReads += 1;return paneReads == 1 ? [retainedDetails.pane] : [detailsHandles[9]]},source:{},capture:{tooltipPaneCapture},focused:{_ in focusReads += 1;return true});fatalError("changed final pane authorized tooltip")}
  catch {check(error is Failure && paneReads == 2 && focusReads == 0,"pane is rechecked after slow source and control capture")}
}
for index in [0,2,4,5,6,7] {
  var elements=detailsElements;elements[index]=detailsHandles[9]
  var focusedCalls=0
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{},capture:{FileDetailsPaneCapture(content:[:],target:documentDetailsTarget,elements:elements,playback:[])},focused:{_ in focusedCalls += 1;return true});fatalError("replaced details owner accepted")}
  catch {check(error is Failure && focusedCalls == 0,"tooltip cannot replace any retained pane/card/identity/footer/Download/Close element")}
}
for changed in ["file","page","route"] {
  let target=FileDetailsDownloadTarget(paneIndex:documentDetailsTarget.paneIndex,cardIndex:documentDetailsTarget.cardIndex,fileLinkIndex:documentDetailsTarget.fileLinkIndex,identityIndex:documentDetailsTarget.identityIndex,footerIndex:documentDetailsTarget.footerIndex,controlIndex:documentDetailsTarget.controlIndex,closeIndex:documentDetailsTarget.closeIndex,filePageURL:changed == "page" ? "https://app.slack.com/files/TDEMO/FOTHER" : documentDetailsTarget.filePageURL,url:changed == "file" ? "https://files.slack.com/files-pri/TDEMO-FOTHER/download/other.pdf" : documentDetailsTarget.url,routeKind:changed == "route" ? "unknown" : documentDetailsTarget.routeKind,playbackRequired:documentDetailsTarget.playbackRequired)
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{},capture:{FileDetailsPaneCapture(content:[:],target:target,elements:detailsElements,playback:[])},focused:{_ in true});fatalError("changed tooltip owner target accepted")}
  catch {check(error is Failure,"tooltip requires exact retained file URL, file page and route")}
}
do {
  var captureCalls=0
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{throw Failure(description:"source changed")},capture:{captureCalls += 1;return tooltipPaneCapture},focused:{_ in true});fatalError("failed source verification authorized tooltip")}
  catch {check(error is Failure && captureCalls == 0,"source failure withholds subsequent tooltip proof")}
}
do {
  var focusCalls=0
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{},capture:{throw Failure(description:"incomplete pane")},focused:{_ in focusCalls += 1;return true});fatalError("failed pane capture authorized tooltip")}
  catch {check(error is Failure && focusCalls == 0,"pane capture failure cannot authorize tooltip")}
}
do {
  do {try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{},capture:{FileDetailsPaneCapture(content:[:],target:documentDetailsTarget,elements:detailsElements,playback:[["label":"Pause","value":"1"]])},focused:{_ in true});fatalError("changed playback authorized tooltip")}
  catch {check(error is Failure,"tooltip never weakens retained viewer playback proof")}
}
for mode in ["success","window","source","focus","input-error"] {
  var inputs=0
  do {
    try finalWindowInput(71,currentWindow:{mode == "window" ? 72 : 71},noModal:{
      try verifyFileDetailsTooltipOwner(retainedDetails,panes:{[retainedDetails.pane]},source:{if mode == "source" {throw Failure(description:"source changed")}},capture:{tooltipPaneCapture},focused:{_ in mode != "focus"})
    },input:{inputs += 1;if mode == "input-error" {throw Failure(description:"input may have happened")}})
    check(mode == "success" && inputs == 1,"verified tooltip scope permits exactly one final owned Close input")
  } catch {
    check(mode != "success" && inputs == (mode == "input-error" ? 1 : 0),"changed window/source/focus withholds input and possibly effective input is not replayed")
  }
}

func detailsVideoSourceFixture() -> [[String:Any]] {
  [
    ["index":0,"parent":NSNull(),"role":"AXGroup","classes":["c-message_kit__actions"]],
    ["index":1,"parent":0,"role":"AXGroup","classes":["p-video_message_file","p-video_message_file--gallery_v3"]],
    ["index":2,"parent":1,"role":"AXGroup","classes":["p-video_controls_overlay"]],
    ["index":3,"parent":2,"role":"AXGroup","classes":["p-video_controls_overlay__corner","p-video_controls_overlay__corner--gallery_v3"]],
    ["index":4,"parent":3,"role":"AXPopUpButton","classes":["p-video_message_file--gallery_v3__controls_overlay_ellipsis","p-video_controls_overlay__corner_button"],"label":"More actions"],
    ["index":5,"parent":2,"role":"AXCheckBox","classes":[String](),"label":"Play, 30 seconds","stateValue":"0"],
    ["index":6,"parent":2,"role":"AXGroup","classes":["sr-only"],"id":"caption-description-FFILE"]
  ]
}
func detailsMenuFixture() -> [[String:Any]] {
  var rows = detailsVideoSourceFixture()
  rows[2]["classes"] = ["p-video_controls_overlay","p-video_controls_overlay--active"]
  rows += [
    ["index":7,"parent":3,"role":"AXGroup","classes":["ReactModal__Content","ReactModal__Content--after-open","popover","c-popover__content"],"id":"owned-menu"],
    ["index":8,"parent":7,"role":"AXMenu","classes":["c-menu__items"]]
  ]
  for (offset,label) in ["Download","Share file\u{2026}","Copy link","Open in","View details","Add to section"].enumerated() {
    rows.append(["index":9+offset,"parent":8,"role":"AXMenuItem","classes":["c-menu_item__button"],"label":label])
  }
  rows += [
    ["index":15,"parent":8,"role":"AXSplitter","classes":["c-menu_separator__separator"]],
    ["index":16,"parent":8,"role":"AXSplitter","classes":["c-menu_separator__separator"]]
  ]
  return rows
}
let videoDetailsOpeners = fileDetailsOpenerTargets(detailsVideoSourceFixture(),contextId:"TDEMO")
check(videoDetailsOpeners.count == 1 && videoDetailsOpeners[0].openerKind == "video-menu" && videoDetailsOpeners[0].filePageURL == nil && videoDetailsOpeners[0].fileId == "FFILE", "known inline video can offer only its source-owned details menu")
check(detailsOpeners[0].openerKind == "details-button", "direct details opener is distinguished from video menu")
for (index,field,value) in [
  (1,"classes",["p-video_message_file"] as Any),(3,"classes",["p-video_controls_overlay__corner"] as Any),
  (2,"classes",["unrelated"] as Any),(2,"parent",0 as Any),(4,"parent",2 as Any),
  (4,"classes",["p-video_message_file--gallery_v3__controls_overlay_ellipsis"] as Any),
  (4,"label","More actions for message" as Any),(4,"role","AXButton" as Any),
  (4,"url","https://example.com" as Any),(6,"id","caption-description-finvalid" as Any)
] {
  var rows = detailsVideoSourceFixture();rows[index][field] = value
  check(fileDetailsOpenerTargets(rows,contextId:"TDEMO").isEmpty,"video menu requires exact observed source and corner hierarchy")
}
var competingVideoDetails = detailsVideoSourceFixture()
competingVideoDetails += [["index":7,"parent":1,"role":"AXGroup","classes":["c-file__actions","c-message_actions__container","c-message_actions__group"]],["index":8,"parent":7,"role":"AXButton","classes":["c-message_actions__button"],"label":"View file details"]]
check(fileDetailsOpenerTargets(competingVideoDetails,contextId:"TDEMO").isEmpty,"two possible details openers are not guessed")
let videoMenuTarget = fileDetailsVideoMenuTarget(detailsMenuFixture(),cornerIndex:3)!
check(videoMenuTarget.openerIndex == 4 && videoMenuTarget.popoverIndex == 7 && videoMenuTarget.menuIndex == 8 && videoMenuTarget.controlIndex == 13,"video menu binds its exact View details item inside source corner")
let menuNormalized = try fileDetailsMenuSourceRows(detailsMenuFixture(),mediaIndex:1,controlIndex:4)
check(try transcriptSourceSignature(menuNormalized,0,selectedMediaIndex:1) == transcriptSourceSignature(detailsVideoSourceFixture(),0,selectedMediaIndex:1),"only source-owned menu and active overlay decoration normalize")
check(fileDetailsOpenerTargets(menuNormalized,contextId:"TDEMO").count == 1,"menu normalization preserves original source capability")
for (index,field,value) in [
  (3,"classes",["p-video_controls_overlay__corner"] as Any),(4,"label","More" as Any),
  (4,"parent",2 as Any),(7,"parent",2 as Any),(7,"id","" as Any),(7,"classes",["ReactModal__Content"] as Any),
  (8,"parent",3 as Any),(8,"role","AXGroup" as Any),(8,"classes",["unrelated-menu"] as Any),
  (13,"label","Play" as Any),(13,"role","AXButton" as Any),(13,"url","https://example.com" as Any),
  (13,"parent",3 as Any),(9,"label","Download all" as Any),(15,"classes",["other"] as Any)
] {
  var rows = detailsMenuFixture();rows[index][field] = value
  check(fileDetailsVideoMenuTarget(rows,cornerIndex:3) == nil,"unowned, extra or altered menu controls cannot authorize details")
  do { _ = try fileDetailsMenuSourceRows(rows,mediaIndex:1,controlIndex:4);fatalError("invalid menu normalized") }
  catch { check(error is Failure,"invalid menu prevents source normalization") }
}
for extra in [
  ["index":17,"parent":8,"role":"AXMenuItem","classes":["c-menu_item__button"],"label":"View details"],
  ["index":17,"parent":7,"role":"AXGroup","classes":[String]()],
  ["index":17,"parent":13,"role":"AXTextField","classes":[String]()]
] as [[String:Any]] {
  check(fileDetailsVideoMenuTarget(detailsMenuFixture()+[extra],cornerIndex:3) == nil,"extra menu scopes or editable content invalidate selection")
}
var changedMenuSource = detailsMenuFixture();changedMenuSource[6]["id"] = "caption-description-FOTHER"
check(try transcriptSourceSignature(fileDetailsMenuSourceRows(changedMenuSource,mediaIndex:1,controlIndex:4),0,selectedMediaIndex:1) != transcriptSourceSignature(detailsVideoSourceFixture(),0,selectedMediaIndex:1),"owned menu normalization does not mask source file changes")
var videoDetailsPane = detailsPaneFixture(true)
videoDetailsPane[4]["classes"] = ["p-video_message_file","p-video_message_file--gallery_v3"]
videoDetailsPane[5]["id"] = "caption-description-FFILE"
videoDetailsPane[8]["classes"] = ["p-video_controls_overlay__controls__pill"]
videoDetailsPane[8]["label"] = "Play, 30 seconds"
let videoDetailsTarget = detailTarget(videoDetailsPane,true)
check(videoDetailsTarget != nil && videoDetailsTarget?.identityIndex == 5 && videoDetailsTarget?.fileLinkIndex == nil && videoDetailsTarget?.playbackRequired == true,"active video pane binds owned caption identity and observed Download without fabricating a page")
for (index,field,value) in [(4,"classes",["p-video_message_file"] as Any),(5,"id","caption-description-FOTHER" as Any),(5,"role","AXStaticText" as Any),(5,"classes",["other"] as Any),(8,"role","AXButton" as Any),(8,"label","Unknown player" as Any)] {
 var rows = videoDetailsPane;rows[index][field] = value
 check(detailTarget(rows,true) == nil,"video pane requires owned canonical caption identity and recognized idle player shape")
}
check(retainedDetails.receipt["openerKind"] as? String == "details-button" && retainedDetailsOpener.receipt["openerKind"] as? String == "details-button","details receipts preserve opener kind")

func replaceDetailsCapture(
  _ capture:FileDetailsDownloadCapture, observation:[String:Any]? = nil,
  target:FileDetailsDownloadTarget? = nil, elements:[Int:AXUIElement]? = nil,
  sourcePlayback:[[String:Any]]? = nil, viewerPlayback:[[String:Any]]? = nil
) -> FileDetailsDownloadCapture {
  FileDetailsDownloadCapture(observation:observation ?? capture.observation,target:target ?? capture.target,elements:elements ?? capture.elements,sourcePlayback:sourcePlayback ?? capture.sourcePlayback,viewerPlayback:viewerPlayback ?? capture.viewerPlayback)
}
func rejectDetailsRecoveryCandidate(
  opener:FileDetailsOpenerCandidate, pane:AXUIElement,
  before:FileDetailsDownloadCapture, after:FileDetailsDownloadCapture
) {
  do {
    _ = try verifiedFileDetailsCandidate(opener:opener,pane:pane,before:before,after:after,contextId:"TDEMO")
    fatalError("unverified file-details recovery candidate accepted")
  } catch {check(error is Failure,"details cleanup needs complete exact source, pane, playback and retained identity proof")}
}
let recoveryDetailsHandles=(0..<30).map {AXUIElementCreateApplication(pid_t(740000+$0))}
for kind in ["file","audio","video"] {
  let sourceRows=kind == "file" ? detailsSourceFixture() : kind == "audio" ? detailsSourceFixture(true) : detailsVideoSourceFixture()
  let paneRows=kind == "file" ? detailsPaneFixture() : kind == "audio" ? detailsPaneFixture(true) : videoDetailsPane
  let sourceTarget=fileDetailsOpenerTargets(sourceRows,contextId:"TDEMO")[0]
  let paneTarget=fileDetailsDownloadTarget(paneRows,fileId:sourceTarget.fileId,sourceFilePageURL:sourceTarget.filePageURL,contextId:"TDEMO")!
  let sourcePlayback:[[String:Any]]=kind == "file" ? [] : [["label":"Play","value":"0"]]
  let panePlayback:[[String:Any]]=kind == "file" ? [] : [["label":kind == "video" ? "Play, 30 seconds" : "Play","value":"0"]]
  let opener=FileDetailsOpenerCandidate(token:"recovery-"+kind,target:sourceTarget,container:recoveryDetailsHandles[20],media:recoveryDetailsHandles[21],control:recoveryDetailsHandles[24],filePage:sourceTarget.filePageIndex == nil ? nil : recoveryDetailsHandles[22],signature:try transcriptSourceSignature(sourceRows,0,selectedMediaIndex:1),videoPins:TranscriptVideoPins(),playback:sourcePlayback)
  let elements=Dictionary(uniqueKeysWithValues:paneRows.map {($0["index"] as! Int,recoveryDetailsHandles[$0["index"] as! Int])})
  let observation=detailsFullObservation(paneRows:paneRows,sourceRows:sourceRows,sourceFilePageIndex:sourceTarget.filePageIndex,sourcePlayback:sourcePlayback,viewerPlayback:panePlayback)
  let capture=FileDetailsDownloadCapture(observation:observation,target:paneTarget,elements:elements,sourcePlayback:sourcePlayback,viewerPlayback:panePlayback)
  let candidate=try verifiedFileDetailsCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:capture,contextId:"TDEMO")
  check(candidate.target == paneTarget && CFEqual(candidate.close,recoveryDetailsHandles[2]),"document/audio/video cleanup candidates retain the exact fresh Download and Close structure")
  try candidate.verify(capture)
  check(true,"factory candidates remain usable only with the same complete source and pane proof")
  for changedPart in ["content","source"] {
    for complete in [false,nil] as [Bool?] {
      var altered=observation
      var part=altered[changedPart] as! [String:Any]
      var content=changedPart == "source" ? part["content"] as! [String:Any] : part
      if let complete {content["truncated"] = !complete}else{content.removeValue(forKey:"truncated")}
      if changedPart == "source" {part["content"]=content;altered[changedPart]=part}else{altered[changedPart]=content}
      let changed=replaceDetailsCapture(capture,observation:altered)
      rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:changed,after:capture)
      rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:changed)
    }
  }
  for index in [paneTarget.paneIndex,paneTarget.cardIndex,paneTarget.identityIndex,paneTarget.footerIndex,paneTarget.controlIndex,paneTarget.closeIndex] {
    var replaced=elements;replaced[index]=recoveryDetailsHandles[29]
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,elements:replaced))
    replaced.removeValue(forKey:index)
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,elements:replaced),after:capture)
  }
  rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[29],before:capture,after:capture)
  for field in ["url","title"] {
    for side in ["before","after"] {
      var changed=observation;var view=changed[side] as! [String:Any];view[field]="changed";changed[side]=view
      rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changed))
    }
  }
  for field in ["mediaIndex","controlIndex","filePageIndex"] {
    var changed=observation;var source=changed["source"] as! [String:Any];source[field]=99;changed["source"]=source
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,observation:changed),after:capture)
    source.removeValue(forKey:field);changed["source"]=source
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changed))
  }
  for unknownIndex in ["unknown" as Any,false as Any] {
    var changed=observation;var source=changed["source"] as! [String:Any];source["filePageIndex"]=unknownIndex;changed["source"]=source
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changed))
  }
  var editedSource=sourceRows;editedSource[0]["label"]="changed retained message"
  let edited=detailsFullObservation(paneRows:paneRows,sourceRows:editedSource,sourceFilePageIndex:sourceTarget.filePageIndex,sourcePlayback:sourcePlayback,viewerPlayback:panePlayback)
  rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,observation:edited),after:replaceDetailsCapture(capture,observation:edited))
  var foreignPane=paneRows
  if kind == "file" {foreignPane[5]["url"]=detailsPage.replacingOccurrences(of:"FFILE",with:"FOTHER")}
  else {foreignPane[5]["id"]=(kind == "video" ? "caption-description-" : "transcript-description-")+"FOTHER"}
  var changedPane=observation;changedPane["content"]=["truncated":false,"nodes":foreignPane]
  rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changedPane))
  var changedDownload=paneRows;changedDownload[7]["url"]=(paneRows[7]["url"] as! String)+"?changed=1"
  changedPane["content"]=["truncated":false,"nodes":changedDownload]
  rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changedPane))
  let otherTarget=kind == "file" ? audioDetailsTarget : documentDetailsTarget
  rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,target:otherTarget),after:capture)
  for key in ["source","viewer"] {
    var changed=observation;var playback=changed["detailsPlayback"] as! [String:Any];playback[key]=[["label":"Pause","value":"1"]];changed["detailsPlayback"]=playback
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:capture,after:replaceDetailsCapture(capture,observation:changed))
  }
  if kind != "file" {
    for value in ["1" as Any,NSNull(),false as Any] {
      let active:[[String:Any]]=[["label":"Play","value":value]]
      let changed=detailsFullObservation(paneRows:paneRows,sourceRows:sourceRows,sourceFilePageIndex:sourceTarget.filePageIndex,sourcePlayback:sourcePlayback,viewerPlayback:active)
      rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,observation:changed,viewerPlayback:active),after:replaceDetailsCapture(capture,observation:changed,viewerPlayback:active))
    }
    let changed=detailsFullObservation(paneRows:paneRows,sourceRows:sourceRows,sourceFilePageIndex:sourceTarget.filePageIndex,sourcePlayback:[],viewerPlayback:[])
    rejectDetailsRecoveryCandidate(opener:opener,pane:recoveryDetailsHandles[0],before:replaceDetailsCapture(capture,observation:changed,sourcePlayback:[],viewerPlayback:[]),after:capture)
  }
}

let viewerHandles = (0..<12).map { AXUIElementCreateApplication(pid_t(710000 + $0)) }
let viewerSourceObservation:[String:Any] = ["source":["content":["truncated":false,"nodes":viewerSourceFixture()]]]
let viewerRawSignature = try viewerRawSourceSignature(viewerSourceFixture(),0)
let retainedOpener = ViewerOpenerCandidate(token: "opener", target: viewerOpeners[0], container: viewerHandles[10], media: viewerHandles[11], control: viewerHandles[2], signature: viewerSourceSignature, toolbarBaseline:nil)
let retainedViewer = ViewerDownloadCandidate(token: "download", opener: retainedOpener, viewer: viewerHandles[0], branch: viewerHandles[2], media: viewerHandles[3], image: viewerHandles[6], footer: viewerHandles[7], control: viewerHandles[8], close: viewerHandles[9], closeParent: viewerHandles[1], target: viewerTarget!,sourceSignature:viewerRawSignature)
let viewerElements = Dictionary(uniqueKeysWithValues: (0..<10).map { ($0, viewerHandles[$0]) })
try retainedViewer.verify(ViewerDownloadCapture(observation: viewerSourceObservation, target: viewerTarget!, elements: viewerElements))
check(true, "unchanged captured CF identities retain viewer permission")
let retainedBranchViewer = ViewerDownloadCandidate(token:"branch-download",opener:retainedOpener,viewer:viewerHandles[0],branch:viewerHandles[2],media:viewerHandles[3],image:viewerHandles[6],footer:viewerHandles[7],control:viewerHandles[8],close:viewerHandles[9],closeParent:viewerHandles[2],target:branchCloseTarget!,sourceSignature:viewerRawSignature)
try retainedBranchViewer.verify(ViewerDownloadCapture(observation:viewerSourceObservation,target:branchCloseTarget!,elements:viewerElements))
check(true,"new branch-close layout retains all actual viewer CF identities")
for (retained,target) in [(retainedViewer,branchCloseTarget!),(retainedBranchViewer,viewerTarget!)] {
 do {try retained.verify(ViewerDownloadCapture(observation:viewerSourceObservation,target:target,elements:viewerElements));fatalError("moved retained Close accepted")}
 catch {check(error is Failure,"moving the same retained Close between supported owners revokes the prior capability")}
}

for index in [0, 1, 2, 3, 6, 7, 8, 9] {
  var replacedElements = viewerElements; replacedElements[index] = viewerHandles[11]
  do {
    try retainedViewer.verify(ViewerDownloadCapture(observation: viewerSourceObservation, target: viewerTarget!, elements: replacedElements))
    fatalError("replaced retained viewer element accepted")
  } catch { check(error is Failure, "replacing any retained viewer component revokes Download permission") }
  replacedElements.removeValue(forKey: index)
  do {
    try retainedViewer.verify(ViewerDownloadCapture(observation: viewerSourceObservation, target: viewerTarget!, elements: replacedElements))
    fatalError("missing retained viewer element accepted")
  } catch { check(error is Failure, "missing retained viewer component revokes Download permission") }
}
check(retainedViewer.receipt["url"] is NSNull && retainedViewer.receipt["routeKind"] as? String == "unknown", "viewer Download never invents a Download URL or original-file classification")
check(retainedViewer.receipt["openerToken"] as? String == "opener" && retainedViewer.receipt["sourceURL"] as? String == viewerURL, "viewer receipt explicitly links to observed opener evidence")
var alteredViewerSource=viewerSourceFixture();alteredViewerSource[0]["label"]="changed source"
for observation in [[:],["source":["content":["truncated":true,"nodes":viewerSourceFixture()]]],["source":["content":["truncated":false,"nodes":alteredViewerSource]]]] as [[String:Any]] {
  do {try retainedViewer.verify(ViewerDownloadCapture(observation:observation,target:viewerTarget!,elements:viewerElements));fatalError("unverified source capture accepted")}
  catch {check(error is Failure,"retained viewer capability requires complete exact raw source in every capture")}
}
let retainedTransitionViewer = ViewerDownloadCandidate(token:"transition",opener:retainedOpener,viewer:viewerHandles[0],branch:viewerHandles[2],media:viewerHandles[3],image:viewerHandles[6],footer:viewerHandles[7],control:viewerHandles[8],close:viewerHandles[9],closeParent:viewerHandles[1],target:viewerTarget!,sourceSignature:try viewerRawSourceSignature(fileOffscreenRows,0))
try retainedTransitionViewer.verify(ViewerDownloadCapture(observation:["source":["content":["truncated":false,"nodes":fileOffscreenRows]]],target:viewerTarget!,elements:viewerElements))
check(true,"an accepted offscreen source remains usable when the entire raw capture stays exact")
for rows in [fileVisibleRows,highlightFileRows,reorderedFileRows] {
  do {try retainedTransitionViewer.verify(ViewerDownloadCapture(observation:["source":["content":["truncated":false,"nodes":rows]]],target:viewerTarget!,elements:viewerElements));fatalError("viewer source reversal accepted")}
  catch {check(error is Failure,"the two viewer captures and later Download/Close checks cannot reverse or mutate source visibility")}
}

// Failure cleanup earns a new Close-only candidate from complete, source-exact
// captures. These synthetic handles never read or control the running app.
func recoveryViewerCapture(
  rows: [[String:Any]] = viewerModalFixture(), sourceRows: [[String:Any]] = viewerSourceFixture(),
  viewerComplete: Bool? = true, sourceComplete: Bool? = true,
  elements: [Int:AXUIElement] = viewerElements, target: ViewerDownloadTarget = viewerTarget!
) -> ViewerDownloadCapture {
  var content:[String:Any] = ["nodes":rows]
  var source:[String:Any] = ["nodes":sourceRows]
  if let viewerComplete {content["truncated"] = !viewerComplete}
  if let sourceComplete {source["truncated"] = !sourceComplete}
  return ViewerDownloadCapture(observation:["content":content,"source":["content":source]],target:target,elements:elements)
}
func rejectsRecoveryViewerCandidate(
  _ before: ViewerDownloadCapture, _ after: ViewerDownloadCapture,
  viewer: AXUIElement = viewerHandles[0]
) {
  do {
    _ = try verifiedViewerCandidate(opener:retainedOpener,viewer:viewer,before:before,after:after)
    fatalError("unverified cleanup candidate accepted")
  } catch {check(error is Failure,"cleanup candidate requires complete exact source, active image and retained identities")}
}
let recoveryViewer = recoveryViewerCapture()
let recoveryCandidate = try verifiedViewerCandidate(opener:retainedOpener,viewer:viewerHandles[0],before:recoveryViewer,after:recoveryViewer)
check(CFEqual(recoveryCandidate.close,viewerHandles[9]) && recoveryCandidate.target == viewerTarget!,"fresh cleanup candidate retains the exact source-bound Close and target")
for complete in [false,nil] as [Bool?] {
  for capture in [recoveryViewerCapture(viewerComplete:complete),recoveryViewerCapture(sourceComplete:complete)] {
    rejectsRecoveryViewerCandidate(capture,recoveryViewer)
    rejectsRecoveryViewerCandidate(recoveryViewer,capture)
  }
}
for index in [0,1,2,3,6,7,8,9] {
  var replaced=viewerElements;replaced[index]=viewerHandles[11]
  let swapped=recoveryViewerCapture(elements:replaced)
  rejectsRecoveryViewerCandidate(swapped,recoveryViewer)
  rejectsRecoveryViewerCandidate(recoveryViewer,swapped)
  replaced.removeValue(forKey:index)
  rejectsRecoveryViewerCandidate(recoveryViewer,recoveryViewerCapture(elements:replaced))
}
rejectsRecoveryViewerCandidate(recoveryViewer,recoveryViewer,viewer:viewerHandles[11])
let editedRecoverySource=recoveryViewerCapture(sourceRows:alteredViewerSource)
rejectsRecoveryViewerCandidate(editedRecoverySource,recoveryViewer)
rejectsRecoveryViewerCandidate(recoveryViewer,editedRecoverySource)
for url in [viewerURL+"?origin_team=TDEMO","https://files.slack.com/files-tmb/TDEMO-FFILE-thumb/demo.png","https://files.slack.com/files-pri/TDEMO-FOTHER/demo.png"] {
  var changed=viewerModalFixture();changed[6]["url"]=url
  let capture=recoveryViewerCapture(rows:changed)
  rejectsRecoveryViewerCandidate(capture,recoveryViewer)
  rejectsRecoveryViewerCandidate(recoveryViewer,capture)
}
var duplicateRecoveryImage=viewerModalFixture();var duplicateRecoveryNode=duplicateRecoveryImage[6]
duplicateRecoveryNode["index"]=10;duplicateRecoveryImage.append(duplicateRecoveryNode)
rejectsRecoveryViewerCandidate(recoveryViewer,recoveryViewerCapture(rows:duplicateRecoveryImage))
rejectsRecoveryViewerCandidate(recoveryViewer,recoveryViewerCapture(rows:Array(viewerModalFixture().dropLast())))
rejectsRecoveryViewerCandidate(recoveryViewer,recoveryViewerCapture(target:branchCloseTarget!))
rejectsRecoveryViewerCandidate(recoveryViewerCapture(rows:branchCloseViewer),recoveryViewer)
let branchRecovery=recoveryViewerCapture(rows:branchCloseViewer,target:branchCloseTarget!)
let branchRecoveryCandidate=try verifiedViewerCandidate(opener:retainedOpener,viewer:viewerHandles[0],before:branchRecovery,after:branchRecovery)
check(branchRecoveryCandidate.target.closeParentIndex == 2,"cleanup accepts the already supported direct-branch Close only with matching fresh targets")

// Failure cleanup is one-shot Close orchestration. No successful callback can
// convert a prior or uncertain Download into permission for further input.
for downloadAttempted in [false,true] {
 for openerAccepted in [false,true] {
  for closeAttempted in [false,true] {
   for viewerClosed in [false,true] {
    var calls=0,markers=0
    let result=cleanupOwnedViewerAfterFailure(downloadAttempted:downloadAttempted,openerAccepted:openerAccepted,closeAttempted:closeAttempted,viewerClosed:viewerClosed) {beforePress in
      calls += 1;try beforePress();markers += 1;return "unchanged"
    }
    let allowed = !downloadAttempted && openerAccepted && !closeAttempted && !viewerClosed
    check(calls == (allowed ? 1 : 0) && markers == calls,"every prior-input gate withholds cleanup callback before any action")
    check(result["status"] as? String == (allowed ? "closed" : "withheld") && result["closed"] as? Bool == allowed && result["closeAttempted"] as? Bool == allowed,"cleanup outcome distinguishes an accepted single Close from a gate refusal")
    if allowed {check(result["sourceCheck"] as? String == "unchanged","verified cleanup retains its post-close source evidence")}
    else {check(result["error"] is String && result["sourceCheck"] == nil,"withheld cleanup explains its gate without inventing source evidence")}
   }
  }
 }
}
let markerlessCleanup=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {_ in "unchanged"}
check(markerlessCleanup["status"] as? String == "withheld" && markerlessCleanup["closed"] as? Bool == false && markerlessCleanup["closeAttempted"] as? Bool == false,"a callback return without a Close marker cannot claim closure")
for afterPress in [false,true] {
  let result=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {beforePress in
    if afterPress {try beforePress()}
    throw Failure(description:"synthetic source verification failed")
  }
  check(result["status"] as? String == (afterPress ? "unverified" : "withheld") && result["closeAttempted"] as? Bool == afterPress && result["closed"] as? Bool == false,"verification failure after Close preserves input uncertainty and never reports closure")
  check(result["error"] as? String == "synthetic source verification failed" && result["sourceCheck"] == nil,"cleanup preserves the verification error without inventing a successful source check")
}
var closeMarkers=0
let repeatedCleanup=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {beforePress in
  try beforePress();closeMarkers += 1;try beforePress();closeMarkers += 1;return "unchanged"
}
check(closeMarkers == 1 && repeatedCleanup["status"] as? String == "unverified" && repeatedCleanup["closed"] as? Bool == false,"a second Close marker is rejected before a second input can be delivered")

// Synthetic application handles test CF identity without reading or controlling an app.
let graphHandles = (0..<7).map { AXUIElementCreateApplication(pid_t(700000 + $0)) }
  + [AXUIElementCreateApplication(700000)]
check(CFEqual(graphHandles[0], graphHandles[7]), "separately created handles can denote one AX identity")
check(!CFEqual(graphHandles[0], graphHandles[1]), "distinct AX application identities remain distinct")
do {
  var stages:[String] = []
  let value = try finalWindowInput(71,currentWindow:{ stages.append("window"); return 71 },
    noModal:{ stages.append("modal") },verifyControl:{
      stages.append("control"); try verifyThreadReplyControl(graphHandles[0],[graphHandles[7]])
    },input:{ stages.append("input"); return 9 })
  check(value == 9 && stages == ["control","window","modal","input"], "fresh control verification precedes final window/modal checks and exactly one input")
}
for failure in ["window-change","modal-change","control-change","control-duplicate","control-missing","window-error","modal-error"] {
  var stages:[String] = []
  var currentWindow = 71
  var modal = false
  do {
    _ = try finalWindowInput(71,currentWindow:{
      stages.append("window")
      if failure == "window-error" { throw Failure(description:"window unavailable") }
      return currentWindow
    },noModal:{
      stages.append("modal")
      if failure == "modal-error" { throw Failure(description:"modal state unknown") }
      try require(!modal,"modal appeared")
    },verifyControl:{
      stages.append("control")
      if failure == "window-change" { currentWindow = 72 }
      if failure == "modal-change" { modal = true }
      let observed = failure == "control-change" ? [graphHandles[1]] : failure == "control-duplicate" ? [graphHandles[0],graphHandles[7]] : failure == "control-missing" ? [] : [graphHandles[7]]
      try verifyThreadReplyControl(graphHandles[0],observed)
    },input:{ stages.append("input"); return 9 })
    fatalError("unverified final input accepted")
  } catch {
    check(!stages.contains("input") && stages.first == "control", "changed, ambiguous or unavailable final window/modal/control evidence withholds all input")
    check(!failure.hasPrefix("control-") || stages == ["control"], "failed reply control identity stops before later preflight and action")
  }
}
do {
  var attempts = 0
  do {
    try finalWindowInput(71,currentWindow:{71},noModal:{},input:{
      attempts += 1; throw Failure(description:"possibly effective input failed")
    })
    fatalError("input failure discarded")
  } catch { check(attempts == 1, "failed input is never replayed by the final guard") }
}
for owned in [nil,graphHandles[0]] as [AXUIElement?] {
  for failure in ["none","missing","changed","duplicate","window","modal","action"] {
    var attempts = 0, attemptsRecorded = 0, currentWindow = 71
    var surfaces = owned == nil ? [] : [graphHandles[7]]
    var modal = false
    do {
      try finalWindowInput(71,currentWindow:{currentWindow},noModal:{
        try require(!modal,"unrelated modal")
        try require(ownedSurfaceMatches(surfaces,owned),"owned viewer or details pane changed")
      },verifyControl:{
        if failure == "missing" {surfaces = owned == nil ? [graphHandles[1]] : []}
        if failure == "changed" {surfaces = [graphHandles[1]]}
        if failure == "duplicate" {surfaces = [graphHandles[0],graphHandles[7]]}
        if failure == "window" {currentWindow = 72}
        if failure == "modal" {modal = true}
      },input:{
        attemptsRecorded += 1; attempts += 1
        if failure == "action" {throw Failure(description:"possibly effective Download or Close")}
      })
      check(failure == "none" && attempts == 1 && attemptsRecorded == 1,"final route isolation permits exactly one input for the expected absent or owned file surface")
    } catch {
      check(attempts == (failure == "action" ? 1 : 0) && attemptsRecorded == attempts,"changed final file/window/modal evidence records no attempt; a possibly effective action is not replayed")
      check(failure != "none","valid owned file surface must reach the guarded action")
    }
  }
}
let ownedMenu = FileDetailsOwnedMenu(corner:graphHandles[0],popover:graphHandles[1],menu:graphHandles[2],details:graphHandles[3],target:videoMenuTarget)
for isolationTime in [99.0,100.0,101.0] {
  let deadline = Date(timeIntervalSince1970:100)
  var now = Date(timeIntervalSince1970:90), attempts = 0
  do {
    try finalWindowInput(71,currentWindow:{71},noModal:{
      now = Date(timeIntervalSince1970:isolationTime)
    },input:{
      try requireSaveMediaInputBudget(deadline,now:now)
      attempts += 1
    })
    check(isolationTime < 100 && attempts == 1,"unexpired final save input retains exactly one attempt after isolation")
  } catch {
    check(isolationTime >= 100 && attempts == 0,"budget exhausted during final isolation withholds save input and attempt accounting")
  }
}
for failure in ["none","window","modal","action","missing-corner","missing-popover","missing-menu","missing-details","duplicate-menu","foreign-menu","role-corner","role-popover","role-menu","role-details","parent-details","parent-menu","parent-popover"] {
  var attempts = 0, attemptsRecorded = 0, currentWindow = 71, modal = false
  var observed = Array(graphHandles[0...3])
  var roles = ["AXGroup","AXGroup","AXMenu","AXMenuItem","AXMenu","AXUnknown","AXUnknown","AXGroup"]
  var parents = [3:2,2:1,1:0]
  func identityIndex(_ element:AXUIElement) -> Int {graphHandles.firstIndex {CFEqual($0,element)}!}
  do {
    try finalWindowInput(71,currentWindow:{currentWindow},noModal:{
      try require(!modal,"foreign modal")
      try require(fileDetailsOwnedMenuMatches(ownedMenu,nodes:observed,
        roleOf:{roles[identityIndex($0)]},parentEquals:{child,parent in
          guard let index = parents[identityIndex(child)] else {return false}
          return CFEqual(graphHandles[index],parent)
        }),"owned menu no longer verified")
    },verifyControl:{
      if failure == "window" {currentWindow = 72}
      if failure == "modal" {modal = true}
      for (name,index) in [("corner",0),("popover",1),("menu",2),("details",3)] {
        if failure == "missing-"+name {observed.removeAll {CFEqual($0,graphHandles[index])}}
        if failure == "role-"+name {roles[index] = "AXUnknown"}
        if failure == "parent-"+name {parents[index] = 6}
      }
      if failure == "duplicate-menu" {observed.append(graphHandles[2])}
      if failure == "foreign-menu" {observed.append(graphHandles[4])}
    },input:{
      attemptsRecorded += 1; attempts += 1
      if failure == "action" {throw Failure(description:"possibly effective View details")}
    })
    check(failure == "none" && attempts == 1 && attemptsRecorded == 1,"owned video menu reaches one View details input only with the exact present parent chain")
  } catch {
    check(attempts == (failure == "action" ? 1 : 0) && attemptsRecorded == attempts,"changed or absent owned menu withholds input and attempt flags; failed input is not replayed")
    check(failure != "none","valid owned video menu must remain actionable")
  }
}
let identities = AXIdentitySet()
check(!identities.contains(graphHandles[0]), "unseen AX identity is absent")
check(identities.insert(graphHandles[0]), "first AX identity is inserted")
check(identities.contains(graphHandles[7]), "equal alias is already present")
check(!identities.insert(graphHandles[7]), "equal alias is not inserted twice")
check(identities.repeatedReferences == 1, "duplicate identity accounting is explicit")
check(identities.insert(graphHandles[1]), "same-kind distinct identity is retained")
check(identities.count == 2, "identity count measures unique handles")
check(identities.repeatedReferences == 1, "membership reads do not count as duplicate edges")
let graphTime = Date(timeIntervalSince1970: 100)
func graphOrder(_ nodes: [Node]) -> [Int] {
  nodes.map { node in graphHandles.firstIndex { CFEqual($0, node.element) }! }
}
func walkGraph(_ edges: [[Int]], maxNodes: Int = 5000, maxDepth: Int = 40) throws
  -> (nodes: [Node], reads: [Int])
{
  var reads = Array(repeating: 0, count: edges.count)
  let nodes = try tree(graphHandles[0], children: { element in
    let index = graphHandles.firstIndex { CFEqual($0, element) }!
    reads[index] += 1
    return edges[index].map { graphHandles[$0] }
  }, now: { graphTime }, maxNodes: maxNodes, maxDepth: maxDepth)
  return (nodes, reads)
}
let selfLoop = try walkGraph([[7, 1], []], maxNodes: 2, maxDepth: 1)
check(graphOrder(selfLoop.nodes) == [0, 1], "root self-alias cannot hide a valid following sibling")
check(selfLoop.reads == [1, 1], "self-alias is skipped before another child read")
let cycle = try walkGraph([[1], [0, 2], []], maxNodes: 3, maxDepth: 2)
check(graphOrder(cycle.nodes) == [0, 1, 2], "multi-node cycle terminates without losing its exit")
check(cycle.nodes.map { $0.depth } == [0, 1, 2], "cycle removal preserves first-path depths")
check(cycle.reads == [1, 1, 1], "cycle nodes are each read once")
let diamond = try walkGraph([[1, 2], [3], [3], []], maxNodes: 4, maxDepth: 2)
check(graphOrder(diamond.nodes) == [0, 1, 2, 3], "shared descendants retain breadth-first child order")
check(diamond.nodes.map { $0.depth } == [0, 1, 1, 2], "shared descendants retain their shortest discovered depth")
check(diamond.reads == [1, 1, 1, 1], "exact unique-node bound permits duplicate references without rereading them")
let rootBoundary = try walkGraph([[7]], maxNodes: 1, maxDepth: 0)
check(graphOrder(rootBoundary.nodes) == [0], "root cycle at zero depth does not exceed a unique-node bound")
let cycleBoundary = try walkGraph([[1], [0]], maxNodes: 2, maxDepth: 1)
check(graphOrder(cycleBoundary.nodes) == [0, 1], "known cycle edge at maximum depth is skipped")
do {
  _ = try walkGraph([[1, 2], [], []], maxNodes: 2)
  fatalError("unique-node overrun accepted")
} catch { check(error is Failure, "unique-node overrun stops traversal") }
do {
  _ = try walkGraph([[1], []], maxDepth: 0)
  fatalError("unseen child beyond maximum depth accepted")
} catch { check(error is Failure, "unseen child beyond depth bound stops traversal") }
var deadlineClockCalls = 0
var deadlineChildReads = 0
do {
  _ = try tree(graphHandles[0], children: { _ in deadlineChildReads += 1; return [] }, now: {
    defer { deadlineClockCalls += 1 }
    return graphTime.addingTimeInterval(deadlineClockCalls == 0 ? 0 : 1)
  }, budget: 1)
  fatalError("expired traversal deadline accepted")
} catch { check(error is Failure, "exact deadline stops before another AX child read") }
check(deadlineChildReads == 0, "expired traversal performs no child read")
var afterReadTime = graphTime
do {
  _ = try tree(graphHandles[0], children: { _ in
    afterReadTime = graphTime.addingTimeInterval(2)
    return []
  }, now: { afterReadTime }, budget: 1)
  fatalError("last child read exceeded deadline without rejection")
} catch { check(error is Failure, "deadline is checked after the final potentially blocking read") }
let merged = mergeAXChildren([graphHandles[1], graphHandles[0]], windows: [graphHandles[7], graphHandles[2], graphHandles[2], graphHandles[1]])
check(merged.count == 3 && CFEqual(merged[0], graphHandles[1]) && CFEqual(merged[1], graphHandles[0]) && CFEqual(merged[2], graphHandles[2]), "window fallback appends only absent identities and preserves child order")
let windowsOnly = mergeAXChildren([], windows: [graphHandles[0], graphHandles[7], graphHandles[1]])
check(windowsOnly.count == 2 && CFEqual(windowsOnly[0], graphHandles[0]) && CFEqual(windowsOnly[1], graphHandles[1]), "window inventory can recover missing children without duplicate aliases")
let childrenOnly = mergeAXChildren([graphHandles[2], graphHandles[1]], windows: [])
check(childrenOnly.count == 2 && CFEqual(childrenOnly[0], graphHandles[2]) && CFEqual(childrenOnly[1], graphHandles[1]), "missing window inventory does not discard existing children")
AXWalkMemo.invalidate()
check(AXWalkMemo.value(graphHandles[0], kAXRoleAttribute) == nil, "an unwalked element has no remembered attribute")
AXWalkMemo.store(graphHandles[0], ["AXButton" as CFString, nil, "id-1" as CFString])
check((AXWalkMemo.value(graphHandles[7], kAXRoleAttribute) ?? nil) as? String == "AXButton", "walk memo serves the role read by the walk to an equal alias")
if case .some(.none) = AXWalkMemo.value(graphHandles[0], "AXDOMClassList") { check(true, "an attribute the walk found absent stays absent") } else { check(false, "an attribute the walk found absent stays absent") }
check(AXWalkMemo.value(graphHandles[0], kAXChildrenAttribute) == nil && AXWalkMemo.value(graphHandles[0], kAXValueAttribute) == nil, "structure and values are never remembered")
check(AXWalkMemo.value(graphHandles[1], kAXRoleAttribute) == nil, "a distinct element is not served another element's attributes")
check(AXWalkMemo.value(graphHandles[0], kAXRoleAttribute, now: ProcessInfo.processInfo.systemUptime + AXWalkMemo.lifetime) == nil, "remembered attributes expire")
axPause(until: Date())
check(AXWalkMemo.value(graphHandles[0], kAXRoleAttribute) == nil, "any wait drops remembered attributes")
for suffix in ["",", away",", away, 2 replies, has draft"] {
  check(threadListCaptionMatchesHeader("Thread with alex.example (direct message\(suffix))","DDEMO1"), "individual DM thread captions require their canonical header identity")
}
check(threadListCaptionMatchesHeader("Thread in project-help (private channel, 2 replies)",nil), "existing channel thread captions retain their root-link fallback")
for id: String? in [nil,"CDEMO1","GDEMO1","D","DDEMO1\n"] {
  check(!threadListCaptionMatchesHeader("Thread with alex.example (direct message, 2 replies)",id), "missing, non-DM and noncanonical headers cannot authorize Thread with")
}
for caption in ["Thread with alex.example (channel, 2 replies)","Thread with alex.example (private channel, 2 replies)","Thread with alex.example (group direct message, 2 replies)","Thread with alex.example (private direct message, 2 replies)","Thread with alex.example","Thread with  (direct message, 2 replies)"] {
  check(!threadListCaptionMatchesHeader(caption,"DDEMO1"), "Thread with retains the exact individual-DM type and nonempty name")
}
check(threadReplyControlMatches("AXButton", ["c-message__reply_count"], "2 replies"), "the conversation reply-count button opens a thread")
check(threadReplyControlMatches("AXButton", ["c-button-unstyled", "c-search_message__count_pill"], "11 replies - Last reply 1 day ago") && threadReplyControlMatches("AXButton", ["c-search_message__count_pill"], "1 reply - Last reply 16 days ago"), "a search result's reply-count pill opens a thread")
check(!threadReplyControlMatches("AXButton", ["c-search_message__count_pill"], "3 files") && !threadReplyControlMatches("AXButton", ["c-search_message__count_pill"], "replies"), "a search pill without a reply count is not a thread opener")
check(!threadReplyControlMatches("AXLink", ["c-message__reply_count"], "2 replies") && !threadReplyControlMatches("AXButton", ["c-button-unstyled"], "2 replies"), "another role or an unrelated button is not a thread opener")
check(diamond.nodes.map { $0.parent } == [-1, 0, 0, 1], "a walk records the node each node was first reached from")
check(AXWalkMemo.provenClient(in: graphHandles[0]) == nil, "no client is proven before a full verification")
AXWalkMemo.rememberClient(graphHandles[1], in: graphHandles[0])
check(AXWalkMemo.provenClient(in: graphHandles[7]).map { CFEqual($0, graphHandles[1]) } == true, "a proven client is reused for the same app")
check(AXWalkMemo.provenClient(in: graphHandles[2]) == nil, "a proven client is not reused for another app")
check(AXWalkMemo.provenClient(in: graphHandles[0], now: ProcessInfo.processInfo.systemUptime + AXWalkMemo.lifetime) == nil, "a proven client expires")
axPause(until: Date())
check(AXWalkMemo.provenClient(in: graphHandles[0]) == nil, "any wait forgets the proven client")
let tableRows: [[String:Any]] = [
  ["role":"AXTable","parent":NSNull()], ["role":"AXRow","parent":0],
  ["role":"AXCell","parent":1], ["role":"AXStaticText","parent":2],
  ["role":"AXColumn","parent":0]
]
func tableProjection(_ rows:[[String:Any]],cell:Int? = 2,first:Int? = 1,current:Int? = 4,
  changedRole:Int? = nil, failedParent:Int? = nil) throws -> Bool {
  try canonicalTableCellProjection(rows,cell:cell,firstParent:first,currentParent:current,
    liveRole: { index in index == changedRole ? "" : tableRows[index]["role"] as! String },
    parentMatches: { index,parent in index != failedParent && tableRows[index]["parent"] as? Int == parent })
}
check(try tableProjection(tableRows), "row-first cell projection is accepted only within its canonical table")
check(!(try tableProjection(tableRows,cell:nil)), "uncaptured cell cannot use the table projection exception")
check(!(try tableProjection(tableRows,first:nil)), "unknown first parent cannot use the table projection exception")
check(!(try tableProjection(tableRows,current:nil)), "unknown current parent cannot use the table projection exception")
for index in [0,1,2,4] {
  var altered = tableRows; altered[index]["role"] = "AXGroup"
  check(!(try tableProjection(altered)), "all stored roles must establish the exact table, row, cell and column relation")
}
for (index,parent) in [(2,4),(1,4),(4,1),(1,-1),(4,-1)] {
  var altered = tableRows; altered[index]["parent"] = parent == -1 ? NSNull() : parent
  check(!(try tableProjection(altered)), "stored cell/row/column parent mismatches or unknowns reject")
}
var crossTable = tableRows + [["role":"AXTable","parent":NSNull()]]
crossTable[4]["parent"] = 5
check(!(try tableProjection(crossTable)), "same-role table in another attachment cannot authorize a projection")
for index in [0,1,2,4] {
  check(!(try tableProjection(tableRows,changedRole:index)), "fresh changed or unknown roles revoke a formerly valid projection")
}
for index in [1,2,4] {
  check(!(try tableProjection(tableRows,failedParent:index)), "each fresh canonical parent comparison must positively verify")
}
check(!(try tableProjection(tableRows,first:4,current:1)), "column-first traversal is not reparented or accepted")
check(!(try tableProjection(tableRows,cell:99)), "missing first capture row is rejected before any array access")
for (index,role) in [(4,"AXRow"),(1,"AXColumn")] {
  var altered = tableRows; altered[index]["role"] = role
  check(!(try tableProjection(altered)), "row-to-row and column-to-column aliases remain unsupported")
}
var tableProofReads:[String] = []
_ = try canonicalTableCellProjection(tableRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ index in tableProofReads.append("role:\(index)"); return tableRows[index]["role"] as! String },
  parentMatches:{ index,parent in tableProofReads.append("parent:\(index):\(parent)"); return true })
check(tableProofReads == ["role:2","role:1","role:4","role:0","parent:2:1","parent:1:0","parent:4:0"], "projection proof bounds fresh reads to four roles and three parent identities")
do {
  _ = try canonicalTableCellProjection(tableRows,cell:2,firstParent:1,currentParent:4,
    liveRole:{ _ in throw Failure(description:"capture deadline") },parentMatches:{ _,_ in fatalError("parent read after deadline") })
  fatalError("deadline failure swallowed by projection")
} catch { check(error is Failure, "projection proof propagates traversal deadline failure") }
var tableCallbacks:[Int] = []
let tableEdges = [[1,4],[2],[3],[],[2]]
func tableIndex(_ element: AXUIElement) -> Int { graphHandles.firstIndex { CFEqual($0,element) }! }
let tableCapture = try contentSnapshot(graphHandles[0],onNode:{ _,element in tableCallbacks.append(tableIndex(element)) },
  readRow:{ element,index,parent in ["index":index,"parent":parent as Any? ?? NSNull(),"role":tableRows[tableIndex(element)]["role"]!,"label":"cell subtree \(tableIndex(element))"] },
  children:{ element in tableEdges[tableIndex(element)].map { graphHandles[$0] } },
  liveRole:{ element in tableRows[tableIndex(element)]["role"] as! String },
  parentMatches:{ element,parent in tableRows[tableIndex(element)]["parent"] as? Int == tableIndex(parent) })
let capturedTableRows = tableCapture["nodes"] as! [[String:Any]]
check(tableCallbacks == [0,1,2,3,4], "same-table cell projection invokes each native capture callback once")
check(capturedTableRows.count == 5 && capturedTableRows[2]["parent"] as? Int == 1 && capturedTableRows[3]["parent"] as? Int == 2 && capturedTableRows[3]["label"] as? String == "cell subtree 3", "first cell ancestry and full descendant subtree stay intact")
check(tableCapture["tableCellProjections"] as? Int == 1 && tableCapture["repeatedReferences"] as? Int == 1, "successful capture reports the exact accepted table projection count")
func headerEvidence(_ header:CFTypeRef? = graphHandles[4],_ cells:CFTypeRef? = [graphHandles[2]] as CFArray,
  headerResult:AXError = .success,cellsResult:AXError = .success) -> (accepted:Bool,receipt:[String:Any]) {
  tableHeaderEvidence(headerResult:headerResult,header:header,cellsResult:cellsResult,cells:cells,expectedHeader:graphHandles[4],cell:graphHandles[2])
}
check(headerEvidence().accepted, "exact table AXHeader plus one exact column-header cell establishes header projection evidence")
check(!headerEvidence(graphHandles[1]).accepted, "another table header cannot establish the current group")
check(!headerEvidence(graphHandles[4],[graphHandles[3]] as CFArray).accepted, "a different column-header cell cannot authorize this alias")
check(!headerEvidence(graphHandles[4],[graphHandles[2],graphHandles[2]] as CFArray).accepted, "duplicated exact header cell is ambiguous")
check(!headerEvidence(nil).accepted, "missing AXHeader remains unavailable")
check(!headerEvidence(graphHandles[4],nil).accepted, "missing column-header inventory remains unavailable")
check(!headerEvidence(headerResult:.cannotComplete).accepted, "failed header read cannot authorize projection")
check(!headerEvidence(cellsResult:.attributeUnsupported).accepted, "unsupported column headers cannot authorize projection")
check(!headerEvidence("not-an-element" as CFString).accepted, "header value must be a native AX identity")
check(!headerEvidence(graphHandles[4],"not-an-array" as CFString).accepted, "column-header inventory must be an array")
check(!headerEvidence(graphHandles[4],["not-an-element"] as CFArray).accepted, "malformed column-header entries cannot masquerade as AX objects")
check(!headerEvidence(graphHandles[4],Array(repeating:graphHandles[2],count:5001) as CFArray).accepted, "column-header inventory proof stays bounded")
let unavailableHeader = headerEvidence(nil,nil).receipt
check((unavailableHeader["header"] as? [String:Any])?["matchesCurrent"] is NSNull && (unavailableHeader["columnHeaders"] as? [String:Any])?["containsCellExactlyOnce"] is NSNull, "unreadable header evidence remains unknown rather than a negative identity claim")
var headerRows = tableRows; headerRows[4]["role"] = "AXGroup"
var headerProofArguments:[Int] = []
check(try canonicalTableCellProjection(headerRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ headerRows[$0]["role"] as! String },parentMatches:{ headerRows[$0]["parent"] as? Int == $1 },
  headerProof:{ table,header,cell in headerProofArguments = [table,header,cell]; return headerEvidence().accepted }), "canonical row-first header group is accepted only with positive exact header evidence")
check(headerProofArguments == [0,4,2], "header proof is bound to the retained table, alternate group and cell indices")
check(!(try canonicalTableCellProjection(headerRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ headerRows[$0]["role"] as! String },parentMatches:{ headerRows[$0]["parent"] as? Int == $1 },headerProof:{ _,_,_ in false })), "failed header proof keeps the ancestry refusal")
check(!(try canonicalTableCellProjection(headerRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ headerRows[$0]["role"] as! String },parentMatches:{ headerRows[$0]["parent"] as? Int == $1 })), "an arbitrary AXGroup never enters the ordinary column exception")
check(!(try canonicalTableCellProjection(headerRows,cell:2,firstParent:4,currentParent:1,
  liveRole:{ headerRows[$0]["role"] as! String },parentMatches:{ headerRows[$0]["parent"] as? Int == $1 },headerProof:{ _,_,_ in true })), "header-first cell is never reparented to a row")
check(!(try canonicalTableCellProjection(tableRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ tableRows[$0]["role"] as! String },parentMatches:{ tableRows[$0]["parent"] as? Int == $1 },headerProof:{ _,_,_ in true })), "header proof cannot substitute for the alternate AXGroup role")
check(!(try canonicalTableCellProjection(headerRows,cell:2,firstParent:1,currentParent:4,
  liveRole:{ $0 == 4 ? "" : headerRows[$0]["role"] as! String },parentMatches:{ headerRows[$0]["parent"] as? Int == $1 },headerProof:{ _,_,_ in true })), "unknown live header role revokes otherwise positive header evidence")
for missing in [1,2,4] {
  check(!(try canonicalTableCellProjection(headerRows,cell:2,firstParent:1,currentParent:4,
    liveRole:{ headerRows[$0]["role"] as! String },parentMatches:{ $0 != missing && headerRows[$0]["parent"] as? Int == $1 },headerProof:{ _,_,_ in true })), "positive header attributes never bypass any canonical parent check")
}
let mediaChannelTarget: [String: Any] = ["kind":"channel"]
for decoration in ["","* ","! "] {
  for identifier in ["C1","G1"] {
    for kind in ["channel","private channel"] {
      for suffix in ["",", 1 unread highlight"] {
        check(mainListMatchesTitle("\(decoration)project-help (Channel) - Team - Slack",identifier,"project-help (\(kind)\(suffix))"), "main thread root anchor recognizes exact supported channel list qualifiers after title and ID proof")
      }
    }
  }
}
for (title,id,label) in [
  ("project-help (DM) - Team - Slack","D1","project-help (private channel)"),
  ("project-help (DM) - Team - Slack","C1","project-help (private channel)"),
  ("project-help (Channel) - Team - Slack","D1","project-help (private channel)"),
  ("project-help (Channel) - Team - Slack","C1\n","project-help (private channel)"),
  (" (Channel) - Team - Slack","C1"," (private channel)"),
  ("other (Channel) - Team - Slack","C1","project-help (private channel)"),
  ("project-help (Channel) - Team - Slack","C1","other (private channel)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (private channel extra)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (shared channel extra)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (shared channel)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (public channel)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (direct message)"),
  ("project-help (channel) - Team - Slack","C1","project-help (private channel)"),
  ("project-help (Channel) - Team - Slack","C1","project-help (private channel) extra"),
  ("project-help - Team - Slack","C1","project-help (private channel)"),
  ("Project-help (Channel) - Team - Slack","C1","project-help (private channel)"),
  ("prefix project-help (Channel) - Team - Slack","C1","project-help (private channel)")
] {
  check(!mainListMatchesTitle(title,id,label), "channel list labels never relax exact destination title, canonical ID, name or conversation kind")
}
check(!conversationListLabelMatches("project-help (shared channel, 1 unread highlight)","project-help",mediaChannelTarget), "unobserved shared qualifier preserves existing native reader behavior")
check(!conversationListLabelMatches("project-help (shared channel)","project-help",["kind":"dm"]), "shared channel qualifier cannot classify a DM")
for label in ["project-help (channel)", "project-help (channel, unread)", "project-help (private channel)", "project-help (private channel, 2 unread messages)"] {
  check(conversationListLabelMatches(label, "project-help", mediaChannelTarget), "exact public/private channel list accepted")
}
for label in ["other (private channel)", "project-help (private channel extra)", "project-help (direct message)", "project-help (group direct message)", "project-help (channel) extra", "project-help (private channel) extra"] {
  check(!conversationListLabelMatches(label, "project-help", mediaChannelTarget), "foreign or malformed channel list rejected")
}
check(!conversationListLabelMatches("project-help (private channel)", "project-help", ["kind":"dm"]), "DM cannot accept channel list")
check(!conversationListLabelMatches(" (private channel)", "", mediaChannelTarget), "empty destination rejected")
check(!conversationListLabelMatches("project-help (channel)", "project-help", [:]), "unknown target kind rejected")
check(conversationListLabelMatches("Alex (group direct message)", "Alex", ["kind":"dm","dmKind":"group"]), "group DM type remains exact")
do {
  let tick = String(UnicodeScalar(96)!)
  let labelCases: [(String,String)] = [
    ("alpha beta", "Search for: alpha beta"),
    ("\"alpha beta\"", "Search for: &quot;alpha beta&quot;"),
    ("a&b", "Search for: a&amp;b"),
    ("<a>b", "Search for: &lt;a&gt;b"),
    ("a'b", "Search for: a&#39;b"),
    ("a" + tick + "b", "Search for: a" + tick + "b"),
    ("a/b", "Search for: a/b"),
    ("&quot;x&quot;", "Search for: &amp;quot;x&amp;quot;"),
    ("&#34;x&#34;", "Search for: &amp;#34;x&amp;#34;"),
    ("&amp;", "Search for: &amp;amp;"),
    ("\"a&<b>'c\"", "Search for: &quot;a&amp;&lt;b&gt;&#39;c&quot;"),
    ("\u{e9}\"\u{6771}\u{4eac}\"", "Search for: \u{e9}&quot;\u{6771}\u{4eac}&quot;"),
    ("  \"alpha\"  ", "Search for:   &quot;alpha&quot;  "),
    ("\"\u{1f600}\"", "Search for: &quot;\u{1f600}&quot;"),
    ("&\u{0301}<\u{0301}>\u{0301}\"\u{0301}'\u{0301}", "Search for: &amp;\u{0301}&lt;\u{0301}&gt;\u{0301}&quot;\u{0301}&#39;\u{0301}")
  ]
  for (query,expected) in labelCases {
    check(searchPickerQueryLabel(query) == expected, "picker encoding is forward-only, one-pass and preserves all other query characters")
  }
  let query = "\"alpha beta\""
  let encoded = "Search for: &quot;alpha beta&quot;"
  let marker = "c-search_autocomplete__suggestion_item"
  let required = [marker + "--query", marker + "--query--icon-standalone", marker, marker + "_left_aligned"]
  let pseudo = marker + "--pseudo-selected"
  let selected = marker + "--selected"
  let suggestionID = "c-search_autocomplete__suggestion_0"
  func option(_ role:String = "AXStaticText",_ id:String = "c-search_autocomplete__suggestion_0",
    _ name:String = "Search for: &quot;alpha beta&quot;",_ classes:[String]? = nil,_ input:String = "\"alpha beta\"") -> Bool {
    encodedSearchQueryOption(role,id,name,classes ?? required,input)
  }
  for (input,expected) in labelCases where expected != "Search for: \(input)" {
    for classes in [required, required + [pseudo], required + [selected]] {
      check(option("AXStaticText",suggestionID,expected,classes,input), "each observed transformed query has one exact marked query option")
      check(option("AXStaticText",suggestionID,expected,Array(classes.reversed()),input), "class order does not change an otherwise exact finite class inventory")
    }
  }
  for id in ["c-search_autocomplete__suggestion_1", "c-search_autocomplete__suggestion_12", "c-search_autocomplete__suggestion_999"] {
    check(option("AXStaticText",id), "canonical nonzero query option indices are supported")
  }
  for role in ["", "AXButton", "AXComboBox", "AXGroup", "AXLink"] {
    check(!option(role), "encoded label cannot authorize a non-suggestion role")
  }
  check(option("AXMenuItem"), "menu-item picker options are supported alongside static-text options")
  check(suggestionRole("AXStaticText") && suggestionRole("AXMenuItem"), "both observed picker option roles are suggestions")
  for role in ["", "AXButton", "AXGroup", "AXLink", "AXMenu", "axmenuitem"] {
    check(!suggestionRole(role), "only the two observed picker option roles are suggestions")
  }
  for id in ["", "c-search_autocomplete__suggestion_", "c-search_autocomplete__suggestion_x", "c-search_autocomplete__suggestion_-1", "c-search_autocomplete__suggestion_00", "c-search_autocomplete__suggestion_01", "c-search_autocomplete__suggestion_1x", "c-search_autocomplete__suggestion_0\n", "prefix_c-search_autocomplete__suggestion_0"] {
    check(!option("AXStaticText",id), "query option ID must match the whole canonical decimal-index identifier")
  }
  for name in ["Search for: \"alpha beta\"", "Search for: &quot;alpha beta", "Search for: alpha beta&quot;", "Search for: &quot;alpha&quot; beta", "Search for: &#34;alpha beta&#34;", "Search for: &amp;quot;alpha beta&amp;quot;", "Search for: &quot;Alpha beta&quot;", "Search for: &quot;alpha beta&quot; in:other", "Search for: &quot;alpha beta&quot; ", " &quot;alpha beta&quot;", "&quot;alpha beta&quot;"] {
    check(!option("AXStaticText",suggestionID,name), "changed, raw, partially encoded or differently encoded query label is rejected")
  }
  for index in required.indices {
    var missing = required
    missing.remove(at:index)
    check(!option("AXStaticText",suggestionID,encoded,missing), "every required query-option class is necessary")
    check(!option("AXStaticText",suggestionID,encoded,required + [required[index]]), "duplicate required classes cannot masquerade as an exact set")
  }
  for extra in [pseudo + "-other", selected + "-other", marker + "--quick-message", marker + "--quick-message-card", marker + "--channel", marker + "--query-unknown", "unknown"] {
    check(!option("AXStaticText",suggestionID,encoded,required + [extra]), "unknown, navigation and quick-message class variants remain unsupported")
  }
  check(!option("AXStaticText",suggestionID,encoded,required + [pseudo,pseudo]), "duplicate optional pseudo-selection marker is rejected")
  check(!option("AXStaticText",suggestionID,encoded,required + [selected,selected]), "duplicate optional selection marker is rejected")
  check(!option("AXStaticText",suggestionID,encoded,required + [pseudo,selected]), "simultaneous pseudo and actual selection class variants are unsupported")
  check(!option("AXStaticText",suggestionID,encoded,[]), "encoded text alone cannot establish query-option identity")
  for input in ["", "alpha beta", "a/b", "a" + tick + "b", "\u{1f600}"] {
    check(!option("AXStaticText",suggestionID,"Search for: \(input)",required,input), "new encoded route does not widen unchanged or empty query matching")
  }
  check(!option("AXStaticText",suggestionID,encoded,required,"&quot;alpha beta&quot;"), "literal entity input cannot collide with a quoted query")
  check(!option("AXStaticText",suggestionID,"Search for: &amp;quot;alpha beta&amp;quot;",required,query), "double-encoded entity input cannot impersonate the original quoted query")
  check(!option("AXStaticText",suggestionID,"Search for: &quot;:grinning:&quot;",required,"\"\u{1f600}\""), "unobserved emoji-to-shortcode transformations are not decoded or normalized")
  func value(_ observed:String,_ input:String = "\"alpha beta\"",_ queries:Int = 1,_ expected:Int = 1,
    _ isPseudo:Bool = false,_ isSelected:Bool = false) -> Bool {
    encodedSearchQueryValue(observed,input,queryOptionCount:queries,expectedOptionCount:expected,
      expectedPseudoSelected:isPseudo,expectedSelected:isSelected)
  }
  for isPseudo in [false,true] {
    for isSelected in [false,true] {
      check(value(query,query,1,1,isPseudo,isSelected), "literal field value corroborates the unique exact encoded option")
      check(value(query + " \u{2014} Search",query,1,1,isPseudo,isSelected) == (isPseudo || isSelected), "presentation suffix requires that exact option to be pseudo-selected or selected")
    }
  }
  for total in [-1,0,2,3] {
    for observed in [query,query + " \u{2014} Search"] {
      check(!value(observed,query,total,1,true,true), "missing or multiple query markers withhold input even if one encoded label matches")
      check(!value(observed,query,1,total,true,true), "missing or multiple expected options cannot authorize input")
    }
  }
  for observed in ["", "alpha beta", "\"alpha\" beta", "\"Alpha beta\"", " &quot;alpha beta&quot;", "&quot;alpha beta&quot;", query + " ", " " + query, query + " \u{2014} Search extra", query + "\u{2014} Search", query + " \u{2014} Other", query + " \u{2014} Search \u{2014} Search", query + "\n"] {
    check(!value(observed,query,1,1,true,true), "changed literal query or unknown suffix cannot corroborate an encoded label")
  }
  for input in ["", "plain", "a/b", "a" + tick + "b"] {
    check(!value(input,input,1,1,true,true), "encoded field route remains restricted to nonempty transformed queries")
  }
  check(value("&quot;alpha beta&quot;","&quot;alpha beta&quot;"), "literal entity field remains distinct and exact")
  check(!value(query,"&quot;alpha beta&quot;",1,1,true,true), "quoted field cannot corroborate literal entity input")
  check(!value("&quot;alpha beta&quot;",query,1,1,true,true), "literal entity field cannot corroborate quoted input")
  check(!exactGroupLookupQueryOption("Search for: &quot;C1&quot;",required,"C1"), "group-ID corroboration does not inherit search-only encoding")
  check(!sourceIDQueryMatches("&quot;C1&quot;","C1",optionCount:2,exactQueryCount:1), "source-ID corroboration remains literal")
}
let base = ["c-search_autocomplete__suggestion_item"]
func candidate(_ role: String = "AXStaticText", _ id: String = "c-search_autocomplete__suggestion_0",
  _ name: String = "Alex, Casey", _ classes: [String] = base, _ markers: Int = 1,
  _ enabled: Bool = true, _ navigationCount: Int = 1) -> Bool {
  groupLookupSuggestionMatches(role, id, name, classes, markers, enabled, navigationCount)
}
check(candidate(), "one supported group option")
check(candidate("AXMenuItem"), "menu-item group option supported")
check(!candidate("AXButton"), "non-suggestion role rejected")
for id in ["", "c-search_autocomplete__suggestion_x", "c-search_autocomplete__suggestion_0\n"] {
  check(!candidate("AXStaticText", id), "noncanonical suggestion ID rejected")
}
check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", ""), "empty name rejected")
check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", String(repeating: "x", count: 501)), "overlong name rejected")
check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", "Alex, Casey", []), "base class required")
for suffix in ["query", "query--icon-standalone", "quick-message", "quick-message-card"] {
  let classes = base + ["c-search_autocomplete__suggestion_item--" + suffix]
  check(!groupLookupNavigation(classes), "query and quick-message options excluded")
  check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", "Alex, Casey", classes), "nested group marker cannot authorize search/message option")
}
for markers in [0, 2] {
  check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", "Alex, Casey", base, markers), "unique group marker required")
}
check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", "Alex, Casey", base, 1, false), "disabled option rejected")
for total in [0, 2, 3] {
  check(!candidate("AXStaticText", "c-search_autocomplete__suggestion_0", "Alex, Casey", base, 1, true, total), "exactly one total navigation option required")
}
let queryClasses = base + ["c-search_autocomplete__suggestion_item--query"]
check(exactGroupLookupQueryOption("Search for: C1", queryClasses, "C1"), "exact ID query corroborated")
do {
  var selection = CFRange(location:8,length:9)
  let query = "CDEMO123"
  let previewClasses = ["c-search_autocomplete__suggestion_item--query","c-search_autocomplete__suggestion_item--pseudo-selected"]
  let preview: (label:String,classes:[String]) = ("Search for: \(query)",previewClasses)
  let wrongPreview: (label:String,classes:[String]) = ("Search for: COTHER123",previewClasses)
  for dash in ["\u{2014}","\u{2013}"] {
    let presented = "\(query) \(dash) Search"
    check(choiceQueryPresentationMatches(presented,query,[preview]),
      "both observed dash presentations bind to the exact single pseudo-selected query option")
    let invalidOptions: [[(label:String,classes:[String])]] = [
      [],[preview,preview],[wrongPreview],
      [(preview.label,[previewClasses[0]])],[(preview.label,[previewClasses[1]])],
      [(preview.label,[])],[preview,wrongPreview],[(preview.label+" extra",previewClasses)],
    ]
    for options in invalidOptions {
      check(!choiceQueryPresentationMatches(presented,query,options),
        "missing, duplicate, differently bound or non-pseudo-selected query options refuse either dash presentation")
    }
    check(choiceQueryPresentationMatches(presented,query,[preview,("Search for: unrelated",[previewClasses[0]])]),
      "an unselected query suggestion does not replace or duplicate the uniquely pseudo-selected exact option")
  }
  for presented in ["\(query) - Search","\(query) \u{2212} Search","\(query) \u{2014}  Search",
    "\(query) \u{2013} search","\(query) \u{2013} Search extra","prefix\(query) \u{2013} Search",
    "COTHER123 \u{2014} Search","\(query)\u{2014} Search","\(query) \u{2013}Search",
    "\(query) \u{2013} Search\n","\(query) \u{2013} Search \u{2013} Search"] {
    check(!choiceQueryPresentationMatches(presented,query,[preview]),
      "other identifiers, spacing, dash characters and suffix extensions cannot be normalized into an exact query")
  }
  let rawSelection = AXValueCreate(.cfRange,&selection)!
  check(groupPickerRange(rawSelection)?.location == 8 && groupPickerRange(rawSelection)?.length == 9,
    "group-picker diagnostics preserve exact selection range coordinates")
  check(groupPickerRange(nil) == nil && groupPickerRange("not-a-range" as CFString) == nil,
    "missing or wrong-typed selection attributes remain unknown")
  var point = CGPoint(x:1,y:2)
  check(groupPickerRange(AXValueCreate(.cgPoint,&point)) == nil,
    "a non-range accessibility value cannot become selection coordinates")
  let field = GroupPickerFieldState(value:"CDEMO123 \u{2014} Search",range:selection,ranges:[selection,nil],focused:true,matchesRetained:true)
  let option = GroupPickerOptionState(role:"AXStaticText",label:"Project Handover",classes:["c-search_autocomplete__suggestion_item"],selected:true,matchesRetained:true,exactQueryOption:false,hasPress:true,hasShowMenu:false)
  let diagnostic = groupPickerFailureDiagnostic("CDEMO123",fields:[field],options:[option],retainedCandidate:true,allowPending:false)
  let fields = diagnostic["fields"] as! [[String:Any]]
  let options = diagnostic["options"] as! [[String:Any]]
  check(diagnostic["requestedID"] as? String == "CDEMO123" && diagnostic["retainedCandidate"] as? Bool == true && diagnostic["allowPending"] as? Bool == false,
    "failure evidence retains the supplied group reference and collection phase")
  check(fields[0]["value"] as? String == field.value && fields[0]["valueUTF16Length"] as? Int == field.value!.utf16.count
    && (fields[0]["selectedRange"] as? [String:Int]) == ["location":8,"length":9],
    "the exact Query value and primary range survive cleanup in failure metadata")
  let ranges = fields[0]["selectedRanges"] as! [Any]
  check(ranges.count == 2 && ranges[1] is NSNull && fields[0]["selectedRangeCount"] as? Int == 2,
    "malformed individual selection ranges remain null rather than disappearing")
  check(options[0]["hasAXPress"] as? Bool == true && options[0]["hasAXShowMenu"] as? Bool == false
    && options[0]["selected"] as? Bool == true && options[0]["matchesRetainedCandidate"] as? Bool == true,
    "candidate action availability, selection and retained identity are separate booleans")
  check(diagnostic["fieldCount"] as? Int == 1 && diagnostic["optionCount"] as? Int == 1 && diagnostic["truncated"] as? Bool == false,
    "complete bounded diagnostics preserve their observed denominators")
  let unknownField = GroupPickerFieldState(value:nil,range:nil,ranges:nil,focused:nil,matchesRetained:false)
  let unknownOption = GroupPickerOptionState(role:"AXStaticText",label:"Project Handover",classes:[],selected:nil,matchesRetained:nil,exactQueryOption:false,hasPress:nil,hasShowMenu:nil,actionReadStatus:AXError.cannotComplete.rawValue)
  let unknown = groupPickerFailureDiagnostic("CDEMO123",fields:[unknownField],options:[unknownOption],retainedCandidate:false,allowPending:true)
  let unknownFields = unknown["fields"] as! [[String:Any]], unknownOptions = unknown["options"] as! [[String:Any]]
  check(unknownFields[0]["value"] is NSNull && unknownFields[0]["selectedRange"] is NSNull
    && unknownFields[0]["selectedRanges"] is NSNull && unknownFields[0]["focused"] is NSNull,
    "unavailable Query attributes are not relabeled empty or false")
  check(unknownOptions[0]["selected"] is NSNull && unknownOptions[0]["matchesRetainedCandidate"] is NSNull,
    "absence of a retained candidate does not invent an identity mismatch")
  check(unknownOptions[0]["hasAXPress"] is NSNull && unknownOptions[0]["hasAXShowMenu"] is NSNull
    && unknownOptions[0]["actionReadStatus"] as? Int32 == AXError.cannotComplete.rawValue,
    "failed action reads preserve unknown availability and the original AX status")
  let longField = GroupPickerFieldState(value:String(repeating:"v",count:600),range:nil,ranges:Array(repeating:selection,count:12),focused:false,matchesRetained:false)
  let longOption = GroupPickerOptionState(role:String(repeating:"r",count:100),label:String(repeating:"l",count:600),classes:Array(repeating:String(repeating:"c",count:150),count:17),selected:false,matchesRetained:false,exactQueryOption:false,hasPress:false,hasShowMenu:false)
  let bounded = groupPickerFailureDiagnostic("CDEMO123",fields:Array(repeating:longField,count:3),options:Array(repeating:longOption,count:21),retainedCandidate:true,allowPending:false)
  let boundedFields = bounded["fields"] as! [[String:Any]], boundedOptions = bounded["options"] as! [[String:Any]]
  check(boundedFields.count == 2 && boundedOptions.count == 20 && bounded["truncated"] as? Bool == true,
    "diagnostics never emit more than two Query fields or twenty supported options")
  check((boundedFields[0]["value"] as? String)?.count == 500 && boundedFields[0]["valueTruncated"] as? Bool == true,
    "Query value output is bounded and explicitly marked truncated")
  check((boundedOptions[0]["label"] as? String)?.count == 500 && boundedOptions[0]["labelTruncated"] as? Bool == true,
    "option label output is bounded and explicitly marked truncated")
  check((boundedOptions[0]["classes"] as? [String])?.count == 16
    && (boundedOptions[0]["classes"] as? [String])?.allSatisfy {$0.count == 120} == true,
    "option class metadata has bounded item and string sizes")
  check((boundedFields[0]["selectedRanges"] as? [Any])?.count == 8 && boundedFields[0]["selectedRangeCount"] as? Int == 12,
    "selection-range output is bounded without losing its raw denominator")
  let prebounded = groupPickerFailureDiagnostic("CDEMO123",fields:[field],options:[option],retainedCandidate:false,allowPending:true,fieldCount:5,optionCount:30)
  check(prebounded["fieldCount"] as? Int == 5 && prebounded["optionCount"] as? Int == 30 && prebounded["truncated"] as? Bool == true,
    "bounded live reads retain original field and option counts")
  check((boundedOptions[0]["role"] as? String)?.count == 80,"option role metadata is bounded")
}
for label in ["Search for: C10", "Search for: C1 in:channel", "Search for: c1", "C1"] {
  check(!exactGroupLookupQueryOption(label, queryClasses, "C1"), "other query does not corroborate ID")
}
check(!exactGroupLookupQueryOption("Search for: C1", base, "C1"), "query marker required")
check(!exactGroupLookupQueryOption("Search for: C1", queryClasses + ["c-search_autocomplete__suggestion_item--quick-message"], "C1"), "message cannot corroborate query")
check(groupLookupSelectionMatches("Alex, Casey", "Alex, Casey", 1, true), "same candidate/name retained")
do {
  let supported = groupPickerActions(.success,["AXPress","AXShowMenu"] as CFArray)
  check(supported.status == .success && supported.names == ["AXPress","AXShowMenu"],
    "a successful typed action inventory preserves advertised capabilities")
  check(groupPickerActions(.success,[] as CFArray).names == [],
    "a successful empty inventory establishes known capability absence")
  for payload: CFTypeRef? in [nil,"AXPress" as CFString,[NSNumber(value:1)] as CFArray] {
    check(groupPickerActions(.success,payload).names == nil,
      "missing or malformed successful action results stay unknown")
  }
  for status in [AXError.cannotComplete,.apiDisabled,.failure] {
    for payload: CFTypeRef? in [nil,["AXPress"] as CFArray] {
      let observed = groupPickerActions(status,payload)
      check(observed.status == status && observed.names == nil,
        "failed action reads cannot claim advertised or absent capabilities even beside a payload")
    }
  }

}
check(!groupLookupSelectionMatches("Alex, Casey", "Alex, Casey", 1, false), "changed AX identity rejected")
do {
  check(groupLookupInitialUpMatches([1,2],[1,2],candidate:2,selected:[false,false],retainedField:true,queryFocused:true,focusedCount:1),
    "one initial Up requires the retained group last in the unchanged complete unselected option inventory")
  for mutation in 0..<15 {
    var expected = [1,2], observed = [1,2]
    var selected: [Bool?] = [false,false]
    var retainedField = true, queryFocused = true, focusedCount = 1
    switch mutation {
    case 0: expected = []; observed = []; selected = []
    case 1: expected = [2,2]; observed = expected
    case 2: expected = [2,1]; observed = expected
    case 3: expected = [1,3]; observed = expected
    case 4: selected = [true,false]
    case 5: selected = [nil,false]
    case 6: selected = [false]
    case 7: retainedField = false
    case 8: queryFocused = false
    case 9: focusedCount = 2
    case 10: observed = [2,1]
    case 11: observed = [1,2,3]
    case 12: observed = [1,3]
    case 13: focusedCount = 0
    default: observed = [3,2]
    }
    check(!groupLookupInitialUpMatches(expected,observed,candidate:2,selected:selected,retainedField:retainedField,queryFocused:queryFocused,focusedCount:focusedCount),
      "Up refuses missing, duplicate, reordered, replaced or selected options and unavailable retained Query focus")
  }
  let oversized = Array(0...200)
  check(!groupLookupInitialUpMatches(oversized,oversized,candidate:200,selected:Array(repeating:false,count:201),retainedField:true,queryFocused:true,focusedCount:1),
    "the initial Up proof retains the picker inventory bound")
}
check(!groupLookupSelectionMatches("Alex, Casey", "Alex, Morgan", 1, true), "changed name rejected")
check(!groupLookupSelectionMatches("Alex, Casey", nil, 0, false), "missing candidate rejected")
check(!groupLookupSelectionMatches("Alex, Casey", "Alex, Casey", 2, true), "duplicate candidate rejected")
check(!groupLookupSelectionMatches("", "", 1, true), "empty candidate rejected")
let now = Date(timeIntervalSince1970: 100)
try requireGroupLookupBudget(nil, now: now)
try requireGroupLookupBudget(Date(timeIntervalSince1970: 101), now: now)
count += 2
for deadline in [99.0, 100.0] {
  do { try requireGroupLookupBudget(Date(timeIntervalSince1970: deadline), now: now)
    fatalError("expired lookup budget accepted")
  } catch { count += 1 }
}
check(try groupSidebarAbsent(0, nil), "absent row may use lookup")
check(try !groupSidebarAbsent(1, "group"), "exposed group uses sidebar")
for (rows, kind) in [(0, "group"), (1, "channel"), (1, "one-to-one"), (1, "self"), (2, "group")] {
  do { _ = try groupSidebarAbsent(rows, kind); fatalError("conflicting sidebar evidence accepted") }
  catch { count += 1 }
}
do { _ = try groupSidebarAbsent(1, nil); fatalError("unclassified row treated as absent") }
catch { count += 1 }
for id in ["C1", "G1"] {
  check(currentGroupName("Alex, Casey (DM) - Team - Slack", id, id) == "Alex, Casey", "current group title preserves observed name")
}
check(currentGroupName("Alex, Casey (Channel) - Team - Slack", "C1", "C1") == nil, "channel title is not group")
check(currentGroupName("Alex, Casey (DM) - Team - Slack", "D1", "D1") == nil, "individual DM is not group")
check(currentGroupName("Alex, Casey (DM) - Team - Slack", "C1", "C2") == nil, "different current group rejected")
check(currentGroupName(" (DM) - Team - Slack", "C1", "C1") == nil, "empty group title rejected")
check(currentGroupName("Alex, Casey (DM) - Team - Slack", "C1\n", "C1\n") == nil, "noncanonical group ID rejected")
// DMs-view identity comes from header structure, never the preview or ID alone.
check(dmHubIdentity("D1", ["Alex"], 1, 0) == SidebarDM(name:"Alex",kind:"one-to-one"), "direct person header")
check(dmHubIdentity("D1", ["Alex", "\u{00a0}", "(you)"], 2, 0) == SidebarDM(name:"Alex",kind:"self"), "explicit self header")
for id in ["C1", "G1"] {
  check(dmHubIdentity(id, ["Alex, Casey"], 0, 1) == SidebarDM(name:"Alex, Casey",kind:"group"), "explicit stacked group header")
}
check(dmHubIdentity("C1", ["Project", "Alex, Casey"], 0, 1)?.name == "Project", "named group excludes member preview")
check(dmHubIdentity("D1", [" @literal "], 1, 0)?.name == " @literal ", "listing preserves raw names for separate hint safety")
for (id,texts,images,stacks) in [
  ("D1",["Alex"],0,0), ("C1",["Alex, Casey"],1,0), ("C1",["Alex, Casey"],1,1),
  ("D1",["Alex"],1,1), ("C1",["Alex, Casey"],0,2), ("D1",["Alex","AGENT"],1,0),
  ("D1",["Alex","you"],1,0), ("D1",["Alex","","(you)"],1,0), ("D1",["Alex","x","(you)"],1,0),
  ("D1",[" "],1,0), ("D1",[],1,0),
  ("d1",["Alex"],1,0), ("D1\n",["Alex"],1,0)
] {
  check(dmHubIdentity(id,texts,images,stacks) == nil, "unsupported header retains unknown identity")
}
check(dmHubURL(URL(string:"https://app.slack.com/client/T1/dms")!), "canonical DMs route")
for raw in [
  "http://app.slack.com/client/T1/dms", "https://other.slack.com/client/T1/dms", "https://app.slack.com/client/t1/dms",
  "https://app.slack.com/client/T1/dms/", "https://app.slack.com/client/T1/dms?q=x", "https://app.slack.com/client/T1/dms#x",
  "https://app.slack.com/client/T1/C1", "https://app.slack.com/client/T1/dms/more", "https://app.slack.com/client/%541/dms",
  "https://user@app.slack.com/client/T1/dms", "https://app.slack.com:443/client/T1/dms"
] {check(!dmHubURL(URL(string:raw)!), "noncanonical DMs route rejected")}
check(try dmHubRowProgress(["D1","C2","D3"],["C2","D3","G4"]) == "advanced", "virtualized prefix can disappear while edge and order persist")
check(try dmHubRowProgress(["D1","C2","D3"],["D1","C2","D3"]) == "no-progress", "unchanged rows do not claim endpoint")
check(try dmHubRowProgress(["D1","C2","D3"],["C2","D3"]) == "no-progress", "removed prefix alone is not progress")
check(try dmHubRowProgress(["D1","C2","D3"],["D3","G4","D5"]) == "advanced", "edge-only overlap retains downward continuity")
for (before,after) in [
  (["D1","D2"],["D3"]), (["D1","D2"],["D2","D1","D3"]), (["D1","D2"],["G0","D1","D2"]),
  (["D1","D2"],["D1","D2","D2"]), (["D1","D1"],["D1","D2"]), ([],["D1"]), (["D1"],[])
] {
  do {_ = try dmHubRowProgress(before,after);fatalError("unverified DMs list transition accepted")}
  catch {count += 1}
}

check(dmHubFilterTextMatches("\u{00a0} \u{00a0}", ["\u{00a0}", "\u{00a0}"]), "observed whitespace children")
check(dmHubFilterTextMatches(" Alex ", ["Alex", " "]), "field text corroborated by full query")
check(!dmHubFilterTextMatches(" ", ["Selected recipient"]), "unaccounted recipient text rejected")
check(!dmHubFilterTextMatches("Alex Casey", ["Alex"]), "substring cannot corroborate query")
check(!dmHubFilterTextMatches("Alex", ["Casey"]), "changed text rejected")

// Modern Slack DMs search uses a CSS-module destination with no stable class.
// Its direct ancestor chain, not the temporary class hashes, establishes identity.
let modernDMDestination = [
  DMSearchShape(role:"AXGroup",id:"",label:"",classes:["multiSelectInput__uy4YB","small__h3r6J","c-form--small"]),
  DMSearchShape(role:"AXGroup",id:"",label:"",classes:["p-dms_page_header_search_bar"]),
  DMSearchShape(role:"AXGroup",id:"",label:"Search DMs",classes:["p-dms_page_header","p-dms_page_header__search-bar"]),
  DMSearchShape(role:"AXGroup",id:"",label:"Direct Messages",classes:["p-view_contents","p-view_contents--sidebar"])
]
check(dmModernDestinationShape(modernDMDestination), "recorded modern DMs destination hierarchy is recognized")
var alternativeDMDestination = modernDMDestination
alternativeDMDestination[3].label = "Direct messages"
check(dmModernDestinationShape(alternativeDMDestination), "both observed DMs view capitalization variants are recognized")
alternativeDMDestination[0].classes = ["differentModuleHash__next"]
check(dmModernDestinationShape(alternativeDMDestination), "CSS-module hash changes do not alter structural identity")
alternativeDMDestination[0].classes = []
check(dmModernDestinationShape(alternativeDMDestination), "blank destination has no unverified CSS prefix dependency")
for chain in [[], Array(modernDMDestination.prefix(3)), modernDMDestination + [modernDMDestination[3]], [modernDMDestination[1],modernDMDestination[0],modernDMDestination[2],modernDMDestination[3]]] {
  check(!dmModernDestinationShape(chain), "missing, intervening or reordered ancestors cannot establish the direct DMs search hierarchy")
}
for index in 0..<modernDMDestination.count {
  var altered = modernDMDestination
  altered[index].role = "AXButton"
  check(!dmModernDestinationShape(altered), "each DMs search owner must retain its verified group role")
  altered = modernDMDestination; altered[index].id = "other"
  check(!dmModernDestinationShape(altered), "identified foreign control cannot stand in for a blank DMs owner")
  altered = modernDMDestination; altered[index].label = "unexpected"
  check(!dmModernDestinationShape(altered), "each DMs search owner label is verified exactly")
}
for (index, required) in [(1,"p-dms_page_header_search_bar"),(2,"p-dms_page_header"),(2,"p-dms_page_header__search-bar"),(3,"p-view_contents"),(3,"p-view_contents--sidebar")] {
  var altered = modernDMDestination
  altered[index].classes.removeAll { $0 == required }
  check(!dmModernDestinationShape(altered), "every stable hierarchy marker is required")
}
alternativeDMDestination = modernDMDestination
alternativeDMDestination[1].classes = ["p-dms_page_header_search_bar__similar"]
check(!dmModernDestinationShape(alternativeDMDestination), "stable class prefixes do not establish search ownership")

// UI diagnostics parse their own bounds even when the native helper is invoked directly.
let defaultUI = try UIOptions(["--ui"])
check(defaultUI.limit == 80 && defaultUI.depth == 20 && defaultUI.filter.isEmpty && !defaultUI.prepare, "bounded read-only UI defaults")
let explicitUI = try UIOptions(["--ui","--filter=DMs","--limit=500","--depth=0","--prepare"])
check(explicitUI.limit == 500 && explicitUI.depth == 0 && explicitUI.filter == "DMs" && explicitUI.prepare, "explicit UI capture options")
check(try UIOptions(["--ui","--filter="]).filter.isEmpty, "empty filter means all exposed nodes")
check(try UIOptions(["--ui","--filter=" + String(repeating:"🧭",count:200)]).filter.unicodeScalars.count == 200, "astral filter bound counts Unicode code points")
check(try UIOptions(["--ui","--filter=" + String(repeating:"e\u{0301}",count:100)]).filter.unicodeScalars.count == 200, "combining filter bound counts Unicode code points")
for flags in [
  [], ["--ui",""], ["--limit=1"], ["--ui","--ui"], ["--ui=true"], ["--ui","--prepare=true"],
  ["--ui","--prepare","--prepare"], ["--ui","--filter=x","--filter=y"],
  ["--ui","--limit=0"], ["--ui","--limit=501"], ["--ui","--limit=01"], ["--ui","--limit=+1"],
  ["--ui","--limit=1.0"], ["--ui","--limit=1","--limit=2"], ["--ui","--depth=-1"], ["--ui","--depth=41"],
  ["--ui","--filter=one\ntwo"], ["--ui","--filter=x\u{0085}"],
  ["--ui","--filter=" + String(repeating:"🧭",count:201)], ["--ui","--pages=2"], ["--ui","--unknown"]
] {
  do { _ = try UIOptions(flags); fatalError("invalid UI options accepted") } catch { count += 1 }
}
check(uiRedaction("AXTextField","AXSecureTextField",[]) == "secure-content", "secure subrole redacted")
check(uiRedaction("AXSecureTextField","",[]) == "secure-content", "secure role redacted")
check(uiRedaction("AXTextArea","",[]) == "editable-content", "editable text subtree redacted")
for css in ["p-message_input_unstyled", "p-workspace__input", "p-composer__button", "c-texty_input_unstyled", "c-wysiwyg_container", "ql-editor", "ql-container"] {
  check(uiRedaction("AXGroup","",[css]) == "composer-content", "composer detected before reading content")
}
check(uiRedaction("AXButton","",["p-dms_page_header"]) == nil, "ordinary navigation remains inspectable")
check(uiContentPolicy("AXGroup",[]) == "aggregate-content", "unknown parent aggregate content omitted")
check(uiContentPolicy("AXWebArea",[]) == "aggregate-content", "workspace aggregate content omitted")
check(uiContentPolicy("AXGroup",["p-view_contents"]) == "aggregate-value", "known view permits title only")
check(uiContentPolicy("AXStaticText",[]) == nil, "static text remains available")
var diagnosticReads:[String] = []
let secretRead: (String) -> String = { diagnosticReads.append($0); return "private draft" }
check(uiSafeLabel("composer-content",nil,read:secretRead) == nil && diagnosticReads.isEmpty, "composer labels not read")
check(uiSafeLabel("secure-content",nil,read:secretRead) == nil && diagnosticReads.isEmpty, "secure labels not read")
check(uiSafeLabel(nil,"aggregate-content",read:secretRead) == nil && diagnosticReads.isEmpty, "ancestor title/description/value never read")
check(uiSafeValue(nil,"aggregate-content",read:{diagnosticReads.append("value");return "private draft"}) == nil && diagnosticReads.isEmpty, "ancestor value never read")
check(uiSafeValue("editable-content",nil,read:{diagnosticReads.append("value");return "private draft"}) == nil && diagnosticReads.isEmpty, "editable value never read")
let viewLabel = uiSafeLabel(nil,"aggregate-value",read:{diagnosticReads.append($0);return ""})
check(viewLabel == "" && diagnosticReads == [kAXTitleAttribute,kAXDescriptionAttribute], "known view never reads aggregate AXValue")
diagnosticReads = []
check(uiSafeLabel(nil,nil,read:{diagnosticReads.append($0);return $0 == kAXValueAttribute ? "visible message" : ""}) == "visible message" && diagnosticReads.count == 3, "ordinary static content remains useful")
check(uiSafeValue(nil,nil,read:{"filter query"}) == "filter query", "safe control value retained")
let parents:[Int?] = [nil,0,1,1,0]
let selectedUI = uiSelection(parents,[false,false,false,true,true],4)
check(selectedUI.indices == [0,1,3,4] && !selectedUI.limited, "filtered matches retain ancestors with sparse capture indexes")
let cappedUI = uiSelection(parents,[false,false,false,true,true],3)
check(cappedUI.indices == [0,1,3] && cappedUI.limited, "ancestor context counts toward output cap")
let tooSmallUI = uiSelection(parents,[false,false,false,true,false],1)
check(tooSmallUI.indices.isEmpty && tooSmallUI.limited, "tiny cap cannot emit dangling child")
let diagnosticUI = uiSelection(parents,[false,true,false,true,true],3,priorities:[4,3,4,0,2])
check(diagnosticUI.indices == [0,1,3] && diagnosticUI.limited, "diagnostic priority retains urgent control and ancestors")
check(uiMatches(["AXButton","Direct Messages"],"messages"), "UI filter ignores case")
check(!uiMatches(["Direct Messages"]," messages "), "UI filter preserves literal whitespace")
check(uiDiagnosticPriority("AXComboBox","","Query",[],false) == 0, "query overlay has diagnostic priority")
check(uiDiagnosticPriority("AXStaticText","","message body",[],false) == nil, "diagnostics omit message-only matches")
var clippedUI:[String] = []
check(uiBounded(String(repeating:"🧭",count:1001),"label",&clippedUI).unicodeScalars.count == 1000 && clippedUI == ["label"], "metadata clipping is bounded and explicit")
var retryCalls = 0, retryWaits = 0
let retried:Int = try retryDMHubLoading(Date().addingTimeInterval(10),{
  retryCalls += 1; if retryCalls == 1 {throw DMHubLoading()}; return 7
},wait:{retryWaits += 1})
check(retried == 7 && retryCalls == 2 && retryWaits == 1, "transient loading recaptures once")
retryCalls = 0; retryWaits = 0
do {
  let _:Int = try retryDMHubLoading(Date().addingTimeInterval(10),{retryCalls += 1;throw Failure(description:"scope changed")},wait:{retryWaits += 1})
  fatalError("scope change accepted")
} catch { check(error is Failure && retryCalls == 1 && retryWaits == 0,"scope failure never retried") }
retryCalls = 0; retryWaits = 0
do {
  let _:Int = try retryDMHubLoading(Date().addingTimeInterval(10),{retryCalls += 1;throw DMHubLoading()},wait:{retryWaits += 1})
  fatalError("persistent loading accepted")
} catch { check(error is DMHubLoading && retryCalls == 3 && retryWaits == 2,"loading recapture has finite attempt bound") }
retryCalls = 0; retryWaits = 0
do {
  let _:Int = try retryDMHubLoading(Date().addingTimeInterval(-1),{retryCalls += 1;throw DMHubLoading()},wait:{retryWaits += 1})
  fatalError("expired loading accepted")
} catch { check(retryCalls == 1 && retryWaits == 0,"expired recapture never waits or repeats") }
retryCalls = 0; retryWaits = 0
do {
  let _:Int = try retryDMHubLoading(Date().addingTimeInterval(10),{retryCalls += 1;throw DMHubLoading()},wait:{retryWaits += 1;throw Failure(description:"interrupted")})
  fatalError("interrupted recapture accepted")
} catch { check(error is Failure && retryCalls == 1 && retryWaits == 1,"interruption ends recapture without another attempt") }
check(!uiReadFailure(.success), "successful AX read is not a failure")
for status in [AXError.attributeUnsupported, .actionUnsupported, .noValue] {
  check(!uiReadFailure(status), "ordinary optional AX absence remains unknown")
  check(uiReadFailure(status,required:true), "required tree identity cannot infer absence from unreadable data")
}
for status in [AXError.cannotComplete, .invalidUIElement, .failure, .notImplemented, .apiDisabled, .illegalArgument] {
  check(uiReadFailure(status), "AX transport and stale element failures mark coverage incomplete")
}

let failedMetadata:[(String,String,[String],Int)] = [
  ("","",[],0), ("AXTextField","",[],1), ("AXStaticText","",[],1),
  ("AXGroup","",[],1), ("AXTextArea","",[],1)
]
for (kind,subrole,classes,failures) in failedMetadata {
  let redacted = uiObservedRedaction(kind,subrole,classes,failedReads:failures)
  var reads = 0
  check(redacted == "unreadable-content", "failed privacy discriminator produces redacted stub")
  check(uiSafeLabel(redacted,nil,read:{_ in reads += 1;return "private draft"}) == nil && reads == 0, "failed discriminator prevents title/description/value reads")
  check(uiSafeValue(redacted,nil,read:{reads += 1;return "private draft"}) == nil && reads == 0, "failed discriminator prevents later scalar value read")
  let children:[Int] = uiSafeChildren(redacted,read:{reads += 1;return [1]})
  check(children.isEmpty && reads == 0, "failed discriminator prevents descending into private content")
}
check(uiObservedRedaction("AXStaticText","",[],failedReads:0) == nil, "optional absent metadata leaves ordinary text inspectable")
check(uiObservedRedaction("AXGroup","",["p-message_input_unstyled"],failedReads:0) == "composer-content", "successful composer metadata preserves redaction")
var childReads = 0
check(uiSafeChildren(nil,read:{childReads += 1;return [1]}) == [1] && childReads == 1, "ordinary structural traversal remains available")

for marker in ["*","!"] {
  for id in ["C1","G1"] {
    check(groupDestinationMatches("Alex, Casey (DM) - Team - Slack",id,id,"Alex, Casey"), "plain exact group name remains supported")
    check(groupDestinationMatches("\(marker) Alex, Casey (DM) - Team - Slack",id,id,"Alex, Casey"), "observed exact title decoration preserves verified name")
  }
  for (title,id,expected,name) in [
    ("\(marker) Alex, Casey (DM) - Team - Slack","C2","C1","Alex, Casey"),
    ("\(marker) Alex, Morgan (DM) - Team - Slack","C1","C1","Alex, Casey"),
    ("\(marker) Alex, Casey (Channel) - Team - Slack","C1","C1","Alex, Casey"),
    ("\(marker) Alex, Casey (DM) - Team - Slack","D1","D1","Alex, Casey"),
    ("\(marker) Alex, Casey (DM) - Team - Slack","C1\n","C1\n","Alex, Casey"),
    ("\(marker)Alex, Casey (DM) - Team - Slack","C1","C1","Alex, Casey"),
    ("\(marker)\(marker) Alex, Casey (DM) - Team - Slack","C1","C1","Alex, Casey"),
    ("\(marker)  Alex, Casey (DM) - Team - Slack","C1","C1","Alex, Casey"),
    ("prefix \(marker) Alex, Casey (DM) - Team - Slack","C1","C1","Alex, Casey"),
    ("\(marker)  (DM) - Team - Slack","C1","C1","")
  ] { check(!groupDestinationMatches(title,id,expected,name), "decoration cannot excuse wrong identity, kind or prefix") }
  check(groupDestinationMatches("\(marker) Literal (DM) - Team - Slack","C1","C1","\(marker) Literal"), "literal leading-marker group name is preserved")
  check(groupDestinationMatches("\(marker) \(marker) Literal (DM) - Team - Slack","C1","C1","\(marker) Literal"), "one decoration may precede a literal leading-marker name")

  let decoratedKinds:[(Destination,String,String)] = [(.channel,"C1","Channel"),(.channel,"G1","Channel"),(.dm,"D1","DM")]
  for (kind,id,type) in decoratedKinds {
    check(destinationMatches("Example (\(type)) - Team - Slack",id,"Example",kind), "plain exact destination retained")
    check(destinationMatches("\(marker) Example (\(type)) - Team - Slack",id,"Example",kind), "one observed decoration before exact verified destination")
    check(!destinationMatches("\(marker) Other (\(type)) - Team - Slack",id,"Example",kind), "decoration cannot excuse another destination name")
    check(!destinationMatches("\(marker) Example (\(type == "DM" ? "Channel" : "DM")) - Team - Slack",id,"Example",kind), "decoration cannot excuse another destination kind")
    check(!destinationMatches("\(marker)\(marker) Example (\(type)) - Team - Slack",id,"Example",kind), "arbitrary leading markers rejected")
  }
  check(!destinationMatches("\(marker) Example (DM) - Team - Slack","C1","Example",.dm), "individual DM still requires D identity")
  check(!destinationMatches("\(marker) Example (Channel) - Team - Slack","D1","Example",.channel), "channel still requires C/G identity")
  check(destinationMatches("\(marker) Literal (DM) - Team - Slack","D1","\(marker) Literal",.dm), "literal marked individual name retained")
  check(destinationMatches("\(marker) Literal (Channel) - Team - Slack","C1","\(marker) Literal",.channel), "literal marked channel name retained")
  check(currentGroupCandidates("Alex, Casey (DM) - Team - Slack","C1","C1") == ["Alex, Casey"], "undecorated current group has one candidate")
  check(currentGroupCandidates("\(marker) Alex, Casey (DM) - Team - Slack","C1","C1") == ["\(marker) Alex, Casey","Alex, Casey"], "one alternate requires independent message list corroboration")
  check(currentGroupCandidates("\(marker) \(marker) Literal (DM) - Team - Slack","C1","C1") == ["\(marker) \(marker) Literal","\(marker) Literal"], "current group candidates never strip repeated markers")
  check(currentGroupCandidates("\(marker) Alex, Casey (DM) - Team - Slack","C1","C2").isEmpty, "alternate name cannot bypass exact requested ID")
  check(currentGroupCandidates("\(marker) Alex, Casey (Channel) - Team - Slack","C1","C1").isEmpty, "alternate name cannot turn channel into group")
  check(try corroboratedGroupName(["\(marker) Literal","Literal"],matches:{$0 == "\(marker) Literal"}) == "\(marker) Literal", "literal name retained when its list corroborates it")
  check(try corroboratedGroupName(["\(marker) Literal","Literal"],matches:{$0 == "Literal"}) == "Literal", "decorated alternate accepted only when its list corroborates it")
  check(try corroboratedGroupName(["\(marker) Literal","Literal"],matches:{_ in false}) == nil, "unproven current view cannot be reused")
  do {
    _ = try corroboratedGroupName(["\(marker) Literal","Literal"],matches:{_ in true})
    fatalError("ambiguous current group name accepted")
  } catch { count += 1 }

  let pageGroup:[String:Any] = ["name":"Alex, Casey","kind":"dm","dmKind":"group","conversationId":"C1","requested":"group:C1"]
  check(pageDestinationMatches("\(marker) Alex, Casey (DM) - Team - Slack","C1",pageGroup), "actual pagination predicate accepts corroborated decorated group")
  check(pageDestinationMatches("Alex, Casey (DM) - Team - Slack","C1",pageGroup), "pagination retains undecorated group")
  check(pageDestinationMatches("\(marker) Alex (DM) - Team - Slack","D1",["name":"Alex","kind":"dm"]), "pagination accepts exact decorated individual DM")
  check(pageDestinationMatches("\(marker) general (Channel) - Team - Slack","C1",["name":"general","kind":"channel"]), "pagination accepts exact decorated channel")
  var wrongPageGroup = pageGroup; wrongPageGroup["conversationId"] = "C2"
  check(!pageDestinationMatches("\(marker) Alex, Casey (DM) - Team - Slack","C1",wrongPageGroup), "pagination preserves exact group ID")
  wrongPageGroup = pageGroup; wrongPageGroup["requested"] = "group:C2"
  check(!pageDestinationMatches("\(marker) Alex, Casey (DM) - Team - Slack","C1",wrongPageGroup), "pagination preserves exact requested group reference")
  wrongPageGroup = pageGroup; wrongPageGroup["kind"] = "channel"
  check(!pageDestinationMatches("\(marker) Alex, Casey (DM) - Team - Slack","C1",wrongPageGroup), "pagination preserves group kind")
  check(!pageDestinationMatches("\(marker) Alex (DM) - Team - Slack","C1",["name":"Alex","kind":"dm"]), "pagination does not treat C identity as individual DM")
  var literalPageGroup = pageGroup; literalPageGroup["name"] = "\(marker) Literal"
  check(pageDestinationMatches("\(marker) Literal (DM) - Team - Slack","C1",literalPageGroup), "pagination retains literal marked name")
  check(continuationDestinationName("\(marker) Alex (DM) - Team - Slack","D1","D1","read-dm","Alex") == "Alex", "actual continuation predicate keeps supplied unmarked DM name")
  check(continuationDestinationName("\(marker) general (Channel) - Team - Slack","C1","C1","read-channel","#general") == "general", "continuation preserves channel sigil behavior")
  check(continuationDestinationName("\(marker) Literal (DM) - Team - Slack","D1","D1","read-dm","\(marker) Literal") == "\(marker) Literal", "continuation preserves supplied literal marker")
  check(continuationDestinationName("\(marker) Alex (DM) - Team - Slack","D1","D2","read-dm","Alex") == nil, "continuation rejects another cursor conversation")
  check(continuationDestinationName("\(marker) Alex (Channel) - Team - Slack","C1","C1","read-dm","Alex") == nil, "continuation rejects another operation kind")
  check(continuationDestinationName("\(marker) Alex (DM) - Team - Slack","D1","D1","read-dm","Other") == nil, "continuation rejects another supplied name")
  check(mainListMatchesTitle("\(marker) Alex, Casey (DM) - Team - Slack","C1","Alex, Casey (group direct message)"), "actual thread main-list predicate corroborates decorated group")
  check(mainListMatchesTitle("\(marker) Literal (DM) - Team - Slack","C1","\(marker) Literal (group direct message)"), "thread list preserves literal marked group")
  check(mainListMatchesTitle("\(marker) \(marker) Literal (DM) - Team - Slack","C1","\(marker) Literal (group direct message)"), "thread list permits exactly one decoration")
  check(!mainListMatchesTitle("\(marker) \(marker) Literal (DM) - Team - Slack","C1","Literal (group direct message)"), "thread list cannot strip repeated decoration")
  check(!mainListMatchesTitle("\(marker) Alex, Casey (DM) - Team - Slack","C1","Alex, Casey (channel)"), "thread root fallback preserves group list kind")
  check(!mainListMatchesTitle("\(marker) Alex, Casey (DM) - Team - Slack","C1\n","Alex, Casey (group direct message)"), "thread root fallback preserves canonical conversation ID")
  check(mainListMatchesTitle("\(marker) general (Channel) - Team - Slack","C1","general (channel)"), "thread fallback handles decorated channel")
  check(mainListMatchesTitle("\(marker) Alex (DM) - Team - Slack","D1","Alex (direct message)"), "thread fallback handles decorated individual DM")
  check(!mainListMatchesTitle("prefix \(marker) Alex (DM) - Team - Slack","D1","Alex (direct message)"), "thread fallback rejects arbitrary uncorroborated prefix")
}

for decoration in ["* ","! "] {
  for literal in ["* Literal","! Literal"] {
    let title = "\(decoration)\(literal) (DM) - Team - Slack"
    check(destinationMatches(title,"D1",literal,.dm), "one decoration preserves a supplied literal leading marker")
    check(mainListMatchesTitle(title,"D1","\(literal) (direct message, away)"), "message list corroborates a literal marker after one decoration")
    check(!destinationMatches(title,"D1","Literal",.dm), "mixed markers cannot be stripped repeatedly")
    check(!mainListMatchesTitle(title,"D1","Literal (direct message)"), "uncorroborated stripped literal is rejected")
    check(currentGroupCandidates(title,"C1","C1") == ["\(decoration)\(literal)",literal], "current group keeps literal and one decorated alternate only")
  }
}
for unsupported in ["? ","!! ","** ","! * ","* ! "] {
  let title = "\(unsupported)Example (DM) - Team - Slack"
  check(!destinationMatches(title,"D1","Example",.dm), "unknown or repeated markers do not excuse a name mismatch")
  check(!mainListMatchesTitle(title,"D1","Example (direct message)"), "unknown or repeated markers require exact list corroboration")
  check(!currentGroupCandidates(title,"C1","C1").contains("Example"), "candidate generation does not normalize arbitrary prefixes")
}
check(mainListMatchesTitle("! Alex (DM) - Team - 21 new items - Slack","D1","Alex (direct message, away)"), "observed bang decoration with unread suffix and away list is supported")

check(validDMSearchText("Leah"), "ordinary direct DMs query accepted")
check(!validDMSearchText(""), "search requires a nonempty query")
check(validDMSearchText("", allowEmpty:true), "explicit empty query accepted only when requested")
check(!validDMSearchText(" \u{00a0} "), "whitespace-only search rejected")
check(!validDMSearchText(" \u{00a0} ", allowEmpty:true), "only the exact empty query requests clearing")
check(validDMSearchText(" Leading and trailing "), "literal query whitespace remains valid")
check(validDMSearchText(String(repeating:"x",count:200)), "200 ASCII scalars accepted")
check(!validDMSearchText(String(repeating:"x",count:201)), "201 ASCII scalars rejected")
check(validDMSearchText(String(repeating:"\u{1f9ed}",count:200)), "astral characters count as one scalar each")
check(!validDMSearchText(String(repeating:"\u{1f9ed}",count:201)), "astral queries retain scalar bound")
check(validDMSearchText(String(repeating:"e\u{0301}",count:100)), "200 scalars in 100 combining graphemes accepted")
check(!validDMSearchText(String(repeating:"e\u{0301}",count:101)), "grapheme count cannot bypass scalar bound")
for scalar in Array(0...31) + Array(127...159) {
  let query = "A" + String(UnicodeScalar(scalar)!) + "B"
  check(!validDMSearchText(query) && !validDMSearchText(query, allowEmpty:true), "every C0/C1 control rejected even with allowEmpty")
}
for name in ["Leah, Casey", " Leading", "Trailing ", "* Literal", String(repeating:"\u{1f9ed}",count:200)] {
  check(try groupDMName("group-name:" + name) == name, "group name preserved exactly, including literal whitespace")
}
for query in ["Leah", "@leah", "group:C1", "group-name"] {
  check(try groupDMName(query) == nil, "other destination forms are not group-name references")
}
for query in ["group-name:", "group-name: ", " group-name:Leah", "\tgroup-name:Leah",
  "\u{00a0}group-name:Leah", "group-name:Leah\nCasey",
  "group-name:" + String(repeating:"x",count:201),
  "group-name:" + String(repeating:"e\u{0301}",count:101)] {
  do { _ = try groupDMName(query); fatalError("malformed group-name reference accepted") }
  catch { count += 1 }
}
let querySentinel = "\u{00a0}"
check(managedDMQueryText("\u{00a0} \u{00a0}", [querySentinel,querySentinel]) == "", "observed blank editor recognized")
for query in ["Leah", "\u{00e9}\u{1f9ed}", " Leading", "Trailing ", " ", "\u{00a0}literal\u{00a0}"] {
  check(managedDMQueryText("\u{00a0} \(query) \u{00a0}", [querySentinel,query,querySentinel]) == query,
    "managed editor query requires exact raw value and ordered sentinel children")
}
for (value, children) in [
  ("Leah\u{00a0} \u{00a0}", ["Leah\u{00a0}",querySentinel]),
  ("\u{00a0} Leah \u{00a0}", [querySentinel,"Casey",querySentinel]),
  ("\u{00a0} Casey \u{00a0}", [querySentinel,"Leah",querySentinel]),
  ("\u{00a0} Leah \u{00a0}", [" ","Leah",querySentinel]),
  ("\u{00a0} Leah \u{00a0}", [querySentinel,"Leah"," "]),
  ("\u{00a0} Leah \u{00a0}", [querySentinel,"Leah",querySentinel,"recipient"]),
  ("\u{00a0} Leah \u{00a0}", [querySentinel,querySentinel]),
  ("Leah", ["Leah"])
] {
  check(managedDMQueryText(value, children) == nil, "ghost edits, stale labels and unsupported query shapes rejected")
}

let legacyDMOption = "p-dms_page_header_search_bar__destination__option"
let modernDMOption = "c-select_options_list__option"
let activeDMOption = "c-select_options_list__option--pseudo-active"
let disabledDMOption = "c-select_options_list__option--disabled"
let dmOptionPrefix = "dms_tab_page__destination_option_"
check(dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",[legacyDMOption],directChild:true,listClasses:[]), "legacy DMs option marker remains supported")
check(dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",[legacyDMOption,disabledDMOption],directChild:true,listClasses:[]), "legacy empty option retains its existing later No items validation")
for names in [[modernDMOption],[modernDMOption,activeDMOption],[activeDMOption,modernDMOption]] {
  check(dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",names,directChild:true,listClasses:["c-select_options_list"]), "observed modern options accept only base or pseudo-active class sets under the verified list")
}
for names in [[],[modernDMOption,"unknown"],[modernDMOption,modernDMOption],[modernDMOption,activeDMOption,activeDMOption],[modernDMOption,disabledDMOption],[activeDMOption],[modernDMOption,activeDMOption,"unknown"]] {
  check(!dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",names,directChild:true,listClasses:["c-select_options_list"]), "unknown, duplicate or unobserved disabled modern classes withhold option selection")
}
for names in [[legacyDMOption],[modernDMOption]] {
  check(!dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",names,directChild:false,listClasses:["c-select_options_list"]), "nested or foreign-owned DMs options cannot establish a candidate")
}
for role in ["AXButton","AXGroup",""] {
  check(!dmSearchOptionSupported(role,dmOptionPrefix + "0",[modernDMOption],directChild:true,listClasses:["c-select_options_list"]), "modern DMs option role cannot change")
}
for id in [dmOptionPrefix + "00",dmOptionPrefix + "01",dmOptionPrefix + "-1",dmOptionPrefix + "1\n",dmOptionPrefix,"other_0",dmOptionPrefix + "1.0",dmOptionPrefix + "x"] {
  check(!dmSearchOptionSupported("AXStaticText",id,[modernDMOption],directChild:true,listClasses:["c-select_options_list"]), "option IDs require the complete canonical integer suffix")
}
check(!dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "0",[modernDMOption],directChild:true,listClasses:[]), "generic modern option class requires the verified Slack list marker")
check(dmSearchOptionSupported("AXStaticText",dmOptionPrefix + "12",[modernDMOption],directChild:true,listClasses:["c-select_options_list"]), "multi-digit canonical option index remains supported")
let virtualDMClasses = ["ReactVirtualized__Grid","ReactVirtualized__List","c-select_options_list__virtual_list"]
do {
  let passive = ["AXShowMenu", "AXScrollToVisible"]
  let groupName = "Project Handover"
  let groupSubtitle = "Alex Example, Casey Example"
  func node(_ role:String, _ subrole:String, _ parent:Int, _ children:[Int],
    id:String = "", classes:[String] = [], actions:[String]? = nil,
    text:String? = nil) -> DMNamedGroupNode<Int> {
    DMNamedGroupNode(role:role,subrole:subrole,id:id,classes:classes,parent:parent,
      children:children,actions:actions ?? passive,enabled:true,focused:false,hasURL:false,
      labels: text.map { [nil,nil,$0] } ?? [])
  }
  let fixture: [Int:DMNamedGroupNode<Int>] = [
    0:node("AXStaticText","",9,[1,2,4],id:"dms_tab_page__destination_option_0",
      classes:["c-select_options_list__option","c-select_options_list__option--pseudo-active"],
      actions:["AXPress"]+passive,text:groupName+" "+groupSubtitle),
    1:node("AXGroup","AXEmptyGroup",0,[],classes:["c-small_mpim_entity__mpim_counter"]),
    2:node("AXGroup","AXStrongStyleGroup",0,[3]),
    3:node("AXStaticText","",2,[],text:groupName),
    4:node("AXStaticText","",0,[],text:groupSubtitle),
  ]
  func proof(_ nodes:[Int:DMNamedGroupNode<Int>] = fixture, owner:Int = 9, marker:Int = 1)
    -> DMNamedGroupProof<Int>? {
    dmNamedGroupProof(0,owner:owner,marker:marker,read: { nodes[$0] ?? node("unknown","",-1,[]) })
  }
  let valid = proof()!
  for status in [AXError.noValue,.attributeUnsupported] {
    check(dmNamedGroupSubrole(status,nil) == "","only authoritative absent-subrole results become the plain subrole")
    for payload: CFTypeRef? in ["" as CFString,"AXUnexpected" as CFString,NSNumber(value:1)] {
      check(dmNamedGroupSubrole(status,payload) == nil,"absence results with contradictory payloads cannot establish an empty subrole")
    }
    var absent = fixture
    for id in [0,3,4] {absent[id]!.subrole = dmNamedGroupSubrole(status,nil)}
    check(proof(absent)?.name == groupName,"positive absent-subrole evidence supports plain option and text leaves")
  }
  for value in ["","AXEmptyGroup","AXStrongStyleGroup","AXUnexpected"] {
    check(dmNamedGroupSubrole(.success,value as CFString) == value,"successful subrole strings remain exact without relabeling")
  }
  for value: CFTypeRef? in [nil,NSNumber(value:1),[] as CFArray] {
    check(dmNamedGroupSubrole(.success,value) == nil,"success with missing or non-string subrole data remains unknown")
  }
  for status in [AXError.cannotComplete,.apiDisabled,.invalidUIElement,.failure] {
    for value: CFTypeRef? in [nil,"" as CFString] {
      check(dmNamedGroupSubrole(status,value) == nil,"transport, permission and invalid-element errors cannot masquerade as absent subroles")
    }
  }
  var failedSubrole = fixture
  failedSubrole[0]!.subrole = dmNamedGroupSubrole(.cannotComplete,nil)
  check(proof(failedSubrole) == nil,"a messaging failure still rejects the complete named-group proof")
  for id in [1,2] {
    var absent = fixture
    absent[id]!.subrole = dmNamedGroupSubrole(.noValue,nil)
    check(proof(absent) == nil,"structural marker and title wrapper still require their exact nonempty subroles")
  }
  var successfulDiagnostic: [String:Any]?
  _ = dmNamedGroupProof(0,owner:9,marker:1,read:{fixture[$0]!},onFailure:{successfulDiagnostic = $0})
  check(successfulDiagnostic == nil,"successful named-group proof emits no failure diagnostic")
  for (mutation,stage,predicate,nodeCount) in [(0,"option","subroleEmpty",1),(1,"group-structure","counterChildrenEmpty",4),(2,"text-and-leaves","leafChildrenEmpty",5)] {
    var changed = fixture
    if mutation == 0 {changed[0]!.subrole = nil}
    else {changed[mutation == 1 ? 1 : 3]!.children = nil}
    var diagnostic: [String:Any]?
    let result = dmNamedGroupProof(0,owner:9,marker:1,read:{changed[$0]!},onFailure:{diagnostic = $0})
    check(result == nil && diagnostic?["stage"] as? String == stage
      && (diagnostic?["checks"] as? [String:Bool])?[predicate] == false
      && (diagnostic?["nodes"] as? [[String:Any]])?.count == nodeCount,
      "the exact failing proof stage and predicate are reported without accepting unknown fields")
  }
  var diagnosticNode = fixture[1]!
  diagnosticNode.children = nil
  diagnosticNode.childrenReadStatus = AXError.noValue.rawValue
  diagnosticNode.childrenCountStatus = AXError.success.rawValue
  diagnosticNode.reportedChildCount = 0
  diagnosticNode.role = "private-diagnostic-payload"
  diagnosticNode.subrole = "private-diagnostic-payload"
  diagnosticNode.subroleReadStatus = AXError.noValue.rawValue
  diagnosticNode.subroleValueKind = "private-diagnostic-payload"
  diagnosticNode.id = "private-diagnostic-payload"
  diagnosticNode.classes = ["private-diagnostic-payload"]
  diagnosticNode.actions = ["private-diagnostic-payload"]
  diagnosticNode.labels = [nil,"","private-diagnostic-payload","extra-private-payload"]
  let boundedDiagnostic = dmNamedGroupDiagnostic("private-diagnostic-payload",Array(repeating:diagnosticNode,count:9),checks:["fixedPredicate":false])
  let diagnosticNodes = boundedDiagnostic["nodes"] as! [[String:Any]]
  check(diagnosticNodes.count == 5,"named-group diagnostic node output remains bounded to five")
  check(diagnosticNodes[0]["subroleReadStatus"] as? Int32 == AXError.noValue.rawValue
    && diagnosticNodes[0]["subroleValueKind"] as? String == "unknown",
    "diagnostics preserve raw subrole status while bounding its value-kind metadata")
  check(diagnosticNodes[0]["childrenCount"] is NSNull
    && diagnosticNodes[0]["childrenReadStatus"] as? Int32 == AXError.noValue.rawValue
    && diagnosticNodes[0]["childrenCountStatus"] as? Int32 == AXError.success.rawValue
    && diagnosticNodes[0]["reportedChildCount"] as? Int == 0,
    "unknown child arrays stay distinct from an independently reported zero count")
  check(diagnosticNodes[0]["labelStates"] as? [String] == ["missing","empty","present"],
    "diagnostics distinguish at most three raw label channel states without text")
  check(boundedDiagnostic["stage"] as? String == "unknown","unrecognized diagnostic stages cannot echo arbitrary text")
  let diagnosticJSON = String(decoding:try JSONSerialization.data(withJSONObject:boundedDiagnostic,options:[.sortedKeys]),as:UTF8.self)
  check(!diagnosticJSON.contains("private-diagnostic-payload") && !diagnosticJSON.contains("extra-private-payload"),
    "diagnostics never expose supplied role, subrole, identifier, class, action or label content")
  check(valid.name == groupName && valid.subtitle == groupSubtitle,
    "named groups take the exact owned title while retaining the opaque participant subtitle")
  check(valid.identities == [0,1,2,3,4] && valid.nodes.count == 5,
    "a named group retains all five owned identities for the final selection check")
  var ordinary = fixture
  ordinary[0]!.classes = ["c-select_options_list__option"]
  check(proof(ordinary)?.name == groupName,"both observed modern option class variants support named groups")
  for identity in 0..<5 {
    for mutation in 0..<16 {
      var changed = fixture
      switch mutation {
      case 0: changed[identity]!.role = "AXButton"
      case 1: changed[identity]!.subrole = "unexpected"
      case 2: changed[identity]!.subrole = nil
      case 3: changed[identity]!.id = "foreign"
      case 4: changed[identity]!.classes = ["foreign"]
      case 5: changed[identity]!.classes = nil
      case 6: changed[identity]!.parent = -1
      case 7: changed[identity]!.children = nil
      case 8: changed[identity]!.actions = nil
      case 9: changed[identity]!.actions = identity == 0 ? passive : ["AXPress"]
      case 10: changed[identity]!.focused = true
      case 11: changed[identity]!.focused = nil
      case 12: changed[identity]!.enabled = false
      case 13: changed[identity]!.enabled = nil
      case 14: changed[identity]!.hasURL = true
      default: changed[identity]!.actions = passive + ["AXShowMenu"]
      }
      check(proof(changed) == nil,"unknown role, subrole, ID, class, ownership, state or action fails the complete named-group proof")
    }
  }
  for mutation in 0..<11 {
    var changed = fixture
    switch mutation {
    case 0: changed[0]!.children = [1,2,4,5]
    case 1: changed[0]!.children = [2,1,4]
    case 2: changed[0]!.children = [1,2,2]
    case 3: changed[0]!.children = [1,2]
    case 4: changed[1]!.children = [5]
    case 5: changed[2]!.children = [3,5]
    case 6: changed[2]!.children = []
    case 7: changed[2]!.children = [0]
    case 8: changed[3]!.children = [5]
    case 9: changed[4]!.children = [5]
    default: changed[2]!.children = [9]
    }
    check(proof(changed) == nil,"extra, reordered, duplicate, missing, cyclic or nested content cannot become a named group")
  }
  check(proof(owner:8) == nil && proof(marker:4) == nil,
    "the exact previously verified option owner and unique group marker remain required")
  for identity in [3,4] {
    for text in ["","  ","\n","bad\u{007F}","bad\u{0085}",String(repeating:"x",count:2001)] {
      var changed = fixture
      changed[identity]!.labels = [nil,nil,text]
      changed[0]!.labels = [nil,nil,changed[3]!.text+" "+changed[4]!.text]
      check(proof(changed) == nil,"blank, control-containing and oversized title/subtitle text is refused")
    }
  }
  for mutation in 0..<4 {
    var changed = fixture
    switch mutation {
    case 0: changed[0]!.labels = [nil,nil,groupName]
    case 1: changed[0]!.labels = [nil,nil,groupSubtitle+" "+groupName]
    case 2: changed[3]!.labels = [groupName,"conflicting title",groupName]
    default: changed[4]!.labels = [groupSubtitle,"conflicting subtitle",groupSubtitle]
    }
    check(proof(changed) == nil,"aggregate mismatches and conflicting text channels are refused without splitting the option label")
  }
  var renamed = fixture
  renamed[3]!.labels = [nil,nil,"Project Handover 🎉"]
  renamed[0]!.labels = [nil,nil,renamed[3]!.text+" "+groupSubtitle]
  check(proof(renamed)?.name == "Project Handover 🎉","an exact owned Unicode title stays opaque and intact")
  var subtitleChanged = fixture
  subtitleChanged[4]!.labels = [nil,nil,"Alex Example, Jordan Example"]
  subtitleChanged[0]!.labels = [nil,nil,groupName+" "+subtitleChanged[4]!.text]
  let subtitleProof = proof(subtitleChanged)!
  check(subtitleProof.name == valid.name && subtitleProof.signature != valid.signature,
    "a changed participant subtitle invalidates stability even when the selected title is identical")
  var rawChanged = fixture
  rawChanged[3]!.labels = ["",nil,groupName]
  let rawProof = proof(rawChanged)!
  check(rawProof.name == valid.name && rawProof.signature != valid.signature,
    "a changed unused text channel also invalidates the internal signature")
  var replacement = fixture
  replacement[2]!.children = [5]
  replacement[5] = replacement.removeValue(forKey:3)
  let replaced = proof(replacement)!
  check(replaced.signature == valid.signature && replaced != valid,
    "identical labels on a replaced owned node fail the separate identity proof")
  check(valid == proof(),"an unchanged complete named-group proof remains selectable")
  let handles = (0..<10).map { AXIdentity(element:AXUIElementCreateApplication(pid_t(760000+$0))) }
  func axProof(_ value:DMNamedGroupProof<Int>) -> DMNamedGroupProof<AXIdentity> {
    DMNamedGroupProof(name:value.name,subtitle:value.subtitle,
      identities:value.identities.map {handles[$0]},nodes:value.nodes.map {n in
        DMNamedGroupNode(role:n.role,subrole:n.subrole,id:n.id,classes:n.classes,
          parent:n.parent.map {handles[$0]},children:n.children?.map {handles[$0]},
          actions:n.actions,enabled:n.enabled,focused:n.focused,hasURL:n.hasURL,labels:n.labels)
      })
  }
  func page(_ proof:DMNamedGroupProof<Int>?) -> DMSearchPage {
    DMSearchPage(scope:["query":groupName],matches:[DMSearchMatch(key:"option:0",kind:"group",
      name:groupName,handle:nil,position:1,setSize:1,element:handles[0].element,
      namedGroup:proof.map(axProof))],empty:false)
  }
  check(page(valid).signature != page(subtitleProof).signature && page(valid).signature != page(rawProof).signature,
    "real DM search page signatures retain named-group subtitle and raw text evidence")
  check(page(valid).signature == page(valid).signature && page(nil).signature == page(nil).signature,
    "stable named and existing unnamed search records retain deterministic signatures")
  check(try JSONSerialization.data(withJSONObject:page(valid).record,options:[.sortedKeys])
    == JSONSerialization.data(withJSONObject:page(nil).record,options:[.sortedKeys]),
    "named-group internal evidence does not change public search output formats")
  let originalMatch = page(valid).matches[0]
  check(sameDMSearchMatchIdentity(originalMatch,page(valid).matches[0]),
    "overlapping named-group options preserve unchanged identity evidence")
  check(!sameDMSearchMatchIdentity(originalMatch,page(subtitleProof).matches[0]),
    "changed participant subtitles fail overlap validation after paging")
  check(!sameDMSearchMatchIdentity(originalMatch,page(rawProof).matches[0]),
    "changed unused raw text channels fail overlap validation after paging")
  check(!sameDMSearchMatchIdentity(originalMatch,page(nil).matches[0])
    && !sameDMSearchMatchIdentity(page(nil).matches[0],originalMatch),
    "named-group evidence cannot silently disappear or appear on an overlapping option")
  check(sameDMSearchMatchIdentity(originalMatch,page(replaced).matches[0]),
    "virtualized descendant identities may change while exact text evidence remains stable")
  check(sameDMSearchMatchIdentity(page(nil).matches[0],page(nil).matches[0]),
    "existing unnamed group overlap validation remains supported")
  let virtualizedMatch = DMSearchMatch(key:originalMatch.key,kind:originalMatch.kind,
    name:originalMatch.name,handle:originalMatch.handle,position:originalMatch.position,
    setSize:originalMatch.setSize,element:handles[8].element,namedGroup:originalMatch.namedGroup)
  check(sameDMSearchMatchIdentity(originalMatch,virtualizedMatch),
    "paging does not require AX option identities to survive virtualization")
  for mutation in 0..<6 {
    let changed = DMSearchMatch(key:mutation == 0 ? "option:1" : originalMatch.key,
      kind:mutation == 1 ? "person" : originalMatch.kind,
      name:mutation == 2 ? "Different Project" : originalMatch.name,
      handle:mutation == 3 ? "example" : originalMatch.handle,
      position:mutation == 4 ? 2 : originalMatch.position,
      setSize:mutation == 5 ? 2 : originalMatch.setSize,
      element:originalMatch.element,namedGroup:originalMatch.namedGroup)
    check(!sameDMSearchMatchIdentity(originalMatch,changed),
      "public key, kind, name, handle, position and set size retain their overlap guards")
  }
}

let virtualDMOwner = DMSearchShape(role:"AXGroup",id:"",label:"",classes:virtualDMClasses)
func validVirtualDMOwner(_ shape:DMSearchShape = virtualDMOwner,value:String? = "",hasURL:Bool = false,direct:Bool = true,children:Int = 1,listClasses:[String] = ["c-select_options_list"]) -> Bool {
 dmSearchVirtualOptionsOwner(shape,value:value,hasURL:hasURL,directListChild:direct,listChildCount:children,listClasses:listClasses)
}
check(validVirtualDMOwner(),"exact observed virtual options wrapper is supported")
var reversedVirtualDMOwner=virtualDMOwner;reversedVirtualDMOwner.classes.reverse()
check(validVirtualDMOwner(reversedVirtualDMOwner),"wrapper class order is immaterial but its class set is exact")
for role in ["AXList","AXButton","AXStaticText",""] {
 var owner=virtualDMOwner;owner.role=role
 check(!validVirtualDMOwner(owner),"virtual wrapper cannot become another control kind")
}
var namedVirtualDMOwner=virtualDMOwner;namedVirtualDMOwner.id="other"
check(!validVirtualDMOwner(namedVirtualDMOwner),"named wrapper cannot establish options ownership")
namedVirtualDMOwner=virtualDMOwner;namedVirtualDMOwner.label="Other results"
check(!validVirtualDMOwner(namedVirtualDMOwner),"wrapper text cannot be hidden as aggregate content")
for names in [[String](),Array(virtualDMClasses.dropFirst()),Array(virtualDMClasses.dropLast()),virtualDMClasses+["extra"],virtualDMClasses+[virtualDMClasses[0]],virtualDMClasses+[virtualDMClasses[1]],virtualDMClasses+[virtualDMClasses[2]]] {
 var owner=virtualDMOwner;owner.classes=names
 check(!validVirtualDMOwner(owner),"missing, duplicate or unknown wrapper classes are refused")
}
for value in [nil,"unexpected"] as [String?] {
 check(!validVirtualDMOwner(value:value),"unknown or nonempty wrapper state is refused")
}
check(!validVirtualDMOwner(hasURL:true),"a URL-bearing wrapper is not the observed passive owner")
check(!validVirtualDMOwner(direct:false),"nested or foreign wrapper cannot own suggestions")
for count in [0,2,3] {
 check(!validVirtualDMOwner(children:count),"missing, mixed or duplicate list owners are refused")
}
for names in [[String](),["other"],["c-select_options_list","extra"],["c-select_options_list","c-select_options_list"]] {
 check(!validVirtualDMOwner(listClasses:names),"virtual wrapper requires the exact observed list marker")
}
check(dmSearchOptionChildrenMatch([1,2,3],[1,2,3],same:==),"wrapper inventory preserves every option in native order")
for (children,options) in [([Int](),[Int]()),([],[1]),([1],[]),([1,2],[1]),([1],[1,2]),([2,1],[1,2]),([1,1],[1,2]),([1,3],[1,2])] {
 check(!dmSearchOptionChildrenMatch(children,options,same:==),"extra, missing, duplicate, reordered or foreign wrapper children withhold options")
}
for names in [[legacyDMOption],[legacyDMOption,modernDMOption]] {
 check(!dmSearchOptionSupported("AXStaticText",dmOptionPrefix+"0",names,directChild:true,listClasses:["c-select_options_list"],allowLegacy:false),"legacy option marker remains limited to its original direct-list route")
}
for names in [[modernDMOption],[modernDMOption,activeDMOption]] {
 check(dmSearchOptionSupported("AXStaticText",dmOptionPrefix+"0",names,directChild:true,listClasses:["c-select_options_list"],allowLegacy:false),"virtual wrapper retains exact modern option identity checks")
 check(!dmSearchOptionSupported("AXStaticText",dmOptionPrefix+"0",names,directChild:false,listClasses:["c-select_options_list"],allowLegacy:false),"nested or foreign option remains invalid under a supported virtual wrapper")
}
check(dmSearchSetComplete(["option:0"], [1], [1]), "one advertised group suggestion is complete")
check(dmSearchInteger(NSNumber(value:1)) == 1, "integer ARIA position decoded")
check(dmSearchInteger(NSNumber(value:500)) == 500, "bounded integer set size decoded")
check(dmSearchInteger(nil) == nil, "absent set metadata remains unknown")
for raw: CFTypeRef in [NSNumber(value:true), NSNumber(value:false), NSNumber(value:1.5), NSNumber(value:0), NSNumber(value:-1), NSNumber(value:501), NSNumber(value:Double.nan), NSNumber(value:Double.infinity), "1" as CFString] {
  check(dmSearchInteger(raw) == nil, "malformed ARIA metadata cannot establish uniqueness")
}
check(dmSearchSetComplete(["option:0","option:1"], [1,2], [2,2]), "complete ordered set can establish exact-name uniqueness")
for (keys, positions, sizes) in [
  (["option:0"], [1], [2]),
  (["option:1"], [2], [1]),
  (["option:0","option:1"], [1,1], [2,2]),
  (["option:0","option:1"], [1,2], [2,3]),
  (["option:0","option:0"], [1,2], [2,2])
] { check(!dmSearchSetComplete(keys, positions, sizes), "unexposed, duplicated or inconsistent group candidates cannot authorize a name lookup") }
check(!dmSearchSetComplete(["option:0"], [nil], [nil]), "missing ARIA metadata cannot prove uniqueness")
check(!dmSearchSetComplete([], [], []), "empty suggestions cannot select a group")

// Picker type labels vary in case; destination names and handles do not.
func pickerDMName(_ label: String, role: String = "AXStaticText", id: String = "c-search_autocomplete__suggestion_2", classes: [String] = ["c-search_autocomplete__suggestion_item", "c-search_autocomplete__suggestion_item_left_aligned"]) -> String? {
  dmSuggestionName(role,id,label,classes)
}
for suffix in [", Direct Message", ", direct message"] {
  let name = pickerDMName("Alex" + suffix)
  check(name == "Alex", "both observed type suffixes preserve the exact destination name")
  check(dmSuggestionMatches(name,[],"Alex"), "complete exact person names match")
  for query in ["alex","Al","Alex "," Alex","Alex, Casey"] {
    check(!dmSuggestionMatches(name,[],query), "person names are not case folded, trimmed or substring matched")
  }
  check(dmSuggestionMatches(name,["@alex"],"@alex"), "one exact observed handle matches")
  for handles in [[String](),["@Alex"],["@al"],["@alex","@alex"],["@alex","@casey"]] {
    check(!dmSuggestionMatches(name,handles,"@alex"), "missing, inexact, duplicate or conflicting handle evidence refuses selection")
  }
}
for label in ["Alex, DIRECT MESSAGE","Alex, Direct message","Alex, direct Message","Alex, direct message ","Alex, direct message\n","Alex, Casey","Search for: Alex",", direct message"," , direct message","Alex\n, direct message","Alex\u{007f}, Direct Message"] {
  check(pickerDMName(label) == nil, "only complete observed person suffixes with nonblank control-free names are parsed")
}
for role in ["AXGroup","AXButton","AXLink",""] {
  check(pickerDMName("Alex, direct message",role:role) == nil, "a matching label cannot override the observed picker option role")
}
for id in ["c-search_autocomplete__suggestion_2\n","c-search_autocomplete__suggestion_2\r","c-search_autocomplete__suggestion_2x","c-search_autocomplete__suggestion_","c-search_autocomplete__suggestion_-2","other_2",""] {
  check(pickerDMName("Alex, direct message",id:id) == nil, "picker option identifiers must match the entire canonical pattern")
}
for marker in ["c-search_autocomplete__suggestion_item--query","c-search_autocomplete__suggestion_item--query--icon-standalone","c-search_autocomplete__suggestion_item--quick-message","c-search_autocomplete__suggestion_item--quick-message-extra"] {
  check(pickerDMName("Alex, direct message",classes:["c-search_autocomplete__suggestion_item",marker]) == nil, "query and quick-message options cannot impersonate a person")
}
check(pickerDMName(" Leading , direct message") == " Leading ", "significant name whitespace is preserved, never normalized")
check(!dmSuggestionMatches(nil,["@alex"],"@alex"), "a handle cannot authorize a non-person row")

// The group history marker is UI metadata only in the exact observed layouts.
let directForewordClasses = ["c-button-unstyled","p-message_pane__foreword__avatar","c-avatar","c-avatar--interactive"]
do {
  let description = ForewordNodeShape(role:"AXGroup",classes:["p-message_pane__foreword__description"])
  let classic = [ForewordNodeShape(role:"AXGroup",classes:["p-message_pane__foreword__avatars"]),description,ForewordNodeShape(role:"AXButton",classes:["p-message_pane__foreword__profile-button"])]
  let entity = [ForewordNodeShape(role:"AXButton",classes:["p-new_im_foreword-entity__avatar-button"]),ForewordNodeShape(role:"AXButton",classes:["p-new_im_foreword-entity__name_button"]),description]
  func foreword(_ children:[ForewordNodeShape], _ extra:[ForewordNodeShape] = []) -> Bool {
    isConversationForeword("message-list_0000000000.000001","AXGroup",["c-virtual_list__item"],children,children + extra)
  }
  check(foreword(classic) && foreword(entity), "classic and entity-button welcome layouts are both recognized")
  let channelWelcome = [ForewordNodeShape(role:"AXHeading",classes:["p-message_pane__foreword__title"]),description,ForewordNodeShape(role:"AXButton",classes:["c-button-unstyled"])]
  func channelForeword(_ children:[ForewordNodeShape]) -> Bool {
    isConversationForeword("message-list_0000000000.000001","AXGroup",["c-virtual_list__item"],children,children,kind:"channel")
  }
  check(channelForeword(channelWelcome) && !foreword(channelWelcome), "the channel welcome layout is recognized only for channels")
  check(!channelForeword(classic) && !channelForeword(entity), "DM welcome layouts never authorize a channel row")
  check(!channelForeword(Array(channelWelcome.dropFirst())), "a channel welcome still needs its title heading")
  check(!foreword([description]) && !foreword(Array(entity.dropLast())), "a welcome row still needs one complete observed layout")
  check(!foreword(entity,[ForewordNodeShape(role:"AXGroup",classes:["c-message_kit__actions"])]), "message content inside either layout is never treated as a welcome row")
  let intro = ForewordNodeShape(role:"AXStaticText",classes:[],label:"This conversation is just between you and ")
  let outro = ForewordNodeShape(role:"AXStaticText",classes:[],label:". Take a look at their profile to learn more about them.")
  let profileClasses = ["c-link","c-member_slug","c-member_slug--light","c-member_slug--link"]
  let profile = ForewordNodeShape(role:"AXLink",classes:profileClasses,url:URL(string:"https://demo.slack.com/team/UDEMO"),label:"@Alex Example")
  let linked = [intro,profile,outro]
  func linkedForeword(_ owned:[ForewordNodeShape] = linked, _ extra:[ForewordNodeShape] = [], children:[ForewordNodeShape] = entity, kind:String = "dm") -> Bool {
    isConversationForeword("message-list_0000000000.000001","AXGroup",["c-virtual_list__item"],children,children + owned + extra,kind:kind,descriptionChildren:owned)
  }
  check(linkedForeword(), "the exact entity introduction owns one canonical Slack profile link")
  check(!linkedForeword(children:classic) && !linkedForeword(children:channelWelcome,kind:"channel"), "linked introductions remain exclusive to the individual DM entity layout")
  check(!foreword(entity,linked), "a profile link outside the owned description does not authorize omission")
  for invalid in [Array(linked.dropLast()),linked + [intro],[outro,profile,intro],[intro,profile,ForewordNodeShape(role:"AXStaticText",classes:[],label:"changed")]] {
    check(!linkedForeword(invalid), "linked introductions require exact direct-child order and fixed copy")
  }
  for invalid in [ForewordNodeShape(role:"AXLink",classes:profileClasses + ["unverified"],url:profile.url,label:profile.label),ForewordNodeShape(role:"AXLink",classes:Array(profileClasses.dropLast()),url:profile.url,label:profile.label),ForewordNodeShape(role:"AXLink",classes:profileClasses,url:profile.url,label:""),ForewordNodeShape(role:"AXLink",classes:Array(profileClasses.dropLast())+[profileClasses[0]],url:profile.url,label:profile.label)] {
    check(!linkedForeword([intro,invalid,outro]), "profile links retain exact classes and a nonempty label")
  }
  for invalidURL in ["https://example.com/team/UDEMO","http://demo.slack.com/team/UDEMO","https://user@demo.slack.com/team/UDEMO","https://demo.slack.com:443/team/UDEMO","https://demo.slack.com/team/UDEMO?extra=1","https://demo.slack.com/team/UDEMO#part","https://demo.slack.com/team/%55DEMO","https://demo.slack.com/team/UDEMO/extra","https://demo.slack.com/archives/DDEMO1/p0000000000000001"] {
    let invalid = ForewordNodeShape(role:"AXLink",classes:profileClasses,url:URL(string:invalidURL),label:profile.label)
    check(!linkedForeword([intro,invalid,outro]), "only an unadorned canonical Slack user profile route is accepted")
  }
  for extra in [profile,ForewordNodeShape(role:"AXGroup",classes:["c-message_kit__actions"]),ForewordNodeShape(role:"AXStaticText",classes:["c-timestamp"]),ForewordNodeShape(role:"AXGroup",classes:[],url:URL(string:"https://demo.slack.com/archives/DDEMO1/p0000000000000001"))] {
    check(!linkedForeword(linked,[extra]), "an extra link or message evidence prevents introduction omission")
  }
  check(!linkedForeword(children:entity + [description]), "the linked introduction still requires one description owner")
}
do {
  let exposed = ["1700000100.000001","1700000200.000001","1700000300.000001"]
  check(threadSourceScrollDirection(exposed,"1700000050.000001") == "older", "a root older than every exposed row scrolls toward older messages")
  check(threadSourceScrollDirection(exposed,"1700000400.000001") == "newer", "a root newer than every exposed row scrolls toward newer messages")
  check(threadSourceScrollDirection(exposed,"1700000200.000001") == nil, "an exposed root needs no scroll")
  check(threadSourceScrollDirection(exposed,"1700000250.000001") == nil, "a message that would sit between exposed rows is not in this list")
  check(threadSourceScrollDirection([],"1700000250.000001") == nil, "an empty row inventory cannot choose a direction")
  check(threadSourceScrollDirection(Array(exposed.reversed()),"1700000050.000001") == nil && threadSourceScrollDirection(exposed + [exposed[2]],"1700000400.000001") == nil, "unordered or duplicated rows cannot choose a direction")
}
do {
  let header = ["c-button-unstyled","c-icon_button","p-flexpane_header__control"]
  check(threadCloseButtonMatches("AXButton","Close",header,true), "the enabled header Close button closes the thread pane")
  check(!threadCloseButtonMatches("AXButton","Close",header,false), "a disabled Close button is refused")
  check(!threadCloseButtonMatches("AXPopUpButton","Close",header,true) && !threadCloseButtonMatches("AXButton","More channel actions",header,true), "other header controls are never the close target")
  check(!threadCloseButtonMatches("AXButton","Close",["c-button-unstyled","c-icon_button"],true), "a Close button outside the pane header is refused")
}
do {
  check(channelMemberCount("View all 26 members. Includes Alex, Casey and Sam") == 26, "the header button advertises the member count")
  check(try membersRuntimeLimit(nil,0) == 160,"unpaged members retain their runtime default")
  check(try membersRuntimeLimit(nil,3) == 70,"paged members retain their runtime default")
  for limit in [1,70,160,900] {
    check(try membersRuntimeLimit(String(limit),0) == limit && membersRuntimeLimit(String(limit),3) == limit,"explicit member runtime is independent of the capture page cap")
  }
  for raw in ["","0","901","1000","01","+1","-1","1.0","1e2"," 1","1 ","1\n","1\r","1,000","\u{FF19}"] {
    var rejected = false
    do { _ = try membersRuntimeLimit(raw,0) } catch { rejected = true }
    check(rejected,"runtime accepts only canonical decimal integers from one to nine hundred")
  }
  check(membersFinalStopReason("complete",expired:true) == "complete","completion at the deadline cannot become a time-limit result")
  check(membersFinalStopReason("page-limit",expired:true) == "time-limit","an exhausted runtime is distinguished from the page cap")
  check(membersFinalStopReason("no-progress",expired:false) == "no-progress","an independently observed progress stop is preserved")
  let collectionDeadline = Date(timeIntervalSince1970:100)
  var boundedOperations = 0
  let boundedValue = try membersBeforeDeadline(collectionDeadline,now:{Date(timeIntervalSince1970:99)}) { boundedOperations += 1;return 42 }
  check(boundedValue == 42 && boundedOperations == 1,"collection runs once before its deadline")
  for now in [100.0,101.0] {
    var expired = false
    do { try membersBeforeDeadline(collectionDeadline,now:{Date(timeIntervalSince1970:now)}) { boundedOperations += 1 } }
    catch MembersCollectionStop.deadline { expired = true }
    check(expired && boundedOperations == 1,"a deadline at or before the operation withholds collection")
  }
  var clock = Date(timeIntervalSince1970:99)
  var lateCaptures = 0
  var verifiedCloses = 0
  var collectionExpired = false
  do {
    try membersCheckpoint(cancelled:{false},sample:{},verify:{clock = collectionDeadline},operation:{
      try membersBeforeDeadline(collectionDeadline,now:{clock}) {lateCaptures += 1}
    })
  } catch MembersCollectionStop.deadline { collectionExpired = true }
  if collectionExpired {
    try membersCheckpoint(cancelled:{false},sample:{},verify:{},operation:{verifiedCloses += 1})
  }
  check(collectionExpired && lateCaptures == 0 && verifiedCloses == 1,"a first preflight that consumes the budget withholds capture but permits independently verified closure")
  let runtimeSource = MembersCloseChannel(name:"project-alpha",id:"CDEMO123",url:"https://app.slack.com/client/TDEMO123/CDEMO123")
  check(membersReadSourceMatches(runtimeSource,runtimeSource,expectedWindow:7,observedWindow:7,expectedTotal:20,observedTotal:20),"unchanged canonical channel, window and count establish the retained member source")
  for mutation in 0..<6 {
    var observed: MembersCloseChannel? = runtimeSource
    var window = 7
    var total: Int? = 20
    switch mutation {
    case 0: observed = nil
    case 1: observed = MembersCloseChannel(name:"project-beta",id:runtimeSource.id,url:runtimeSource.url)
    case 2: observed = MembersCloseChannel(name:runtimeSource.name,id:runtimeSource.id,url:"https://app.slack.com/client/TOTHER123/CDEMO123")
    case 3: window = 8
    case 4: total = 21
    default: total = nil
    }
    check(!membersReadSourceMatches(runtimeSource,observed,expectedWindow:7,observedWindow:window,expectedTotal:20,observedTotal:total),"missing or changed source, workspace, window and member count stop a page")
  }
  let runtimeEdges = [MembersReadEdge(child:1,parent:0,siblings:[1,2]),MembersReadEdge(child:3,parent:1,siblings:[3,4]),MembersReadEdge(child:5,parent:3,siblings:[5])]
  check(membersReadEdgesMatch(runtimeEdges,runtimeEdges),"exact retained ownership paths remain valid")
  for mutation in 0..<7 {
    var observed = runtimeEdges
    switch mutation {
    case 0: observed = []
    case 1: observed.removeLast()
    case 2: observed[2] = MembersReadEdge(child:6,parent:3,siblings:[6])
    case 3: observed[1] = MembersReadEdge(child:3,parent:99,siblings:[3,4])
    case 4: observed[1] = MembersReadEdge(child:3,parent:1,siblings:[4,3])
    case 5: observed[1] = MembersReadEdge(child:3,parent:1,siblings:[3,3])
    default: observed[1] = MembersReadEdge(child:3,parent:3,siblings:[3])
    }
    check(!membersReadEdgesMatch(mutation >= 5 ? observed : runtimeEdges,observed),"missing, replaced, reordered, duplicate and self-owned source paths are refused")
  }
  let runtimeFilterID = "ia-details-popover-members--filter-select_button"
  let runtimeFilterClasses = ["c-select_button","c-select_button--medium"]
  check(membersAllFilterMatches("AXComboBox",runtimeFilterID,"Filter by: All","All",runtimeFilterClasses),"exact observed All filter establishes unfiltered membership scope")
  let invalidRuntimeFilters: [(String,String,String,String?,[String])] = [
    ("AXButton",runtimeFilterID,"Filter by: All","All",runtimeFilterClasses),
    ("AXComboBox","foreign","Filter by: All","All",runtimeFilterClasses),
    ("AXComboBox",runtimeFilterID,"Filter by: All people","All",runtimeFilterClasses),
    ("AXComboBox",runtimeFilterID,"Filter by: All","Guests",runtimeFilterClasses),
    ("AXComboBox",runtimeFilterID,"Filter by: All",nil,runtimeFilterClasses),
    ("AXComboBox",runtimeFilterID,"Filter by: All","All",[]),
    ("AXComboBox",runtimeFilterID,"Filter by: All","All",["c-select_button"]),
  ]
  for (role,id,label,value,classes) in invalidRuntimeFilters {
    check(!membersAllFilterMatches(role,id,label,value,classes),"missing, filtered and unsupported controls cannot imply All")
  }
  var runtimeOrder: [String] = []
  let checkpointValue = try membersCheckpoint(cancelled:{false},sample:{runtimeOrder.append("sample")},verify:{runtimeOrder.append("source")},operation:{runtimeOrder.append("operation");return 42})
  check(checkpointValue == 42 && runtimeOrder == ["sample","source","sample","operation"],"desktop and source verification precede exactly one capture or action")
  for mode in 0..<7 {
    var cancelled = mode == 0
    var samples = 0
    var operations = 0
    var rejected = false
    do {
      try membersCheckpoint(cancelled:{cancelled},sample:{
        samples += 1
        if mode == 1 { throw Failure(description:"desktop changed") }
        if (mode == 3 && samples == 1) || (mode == 5 && samples == 2) { cancelled = true }
      },verify:{
        if mode == 2 { throw Failure(description:"source changed") }
        if mode == 4 { cancelled = true }
      },operation:{operations += 1;if mode == 6 {throw Failure(description:"operation failed")}})
    } catch { rejected = true }
    check(rejected && operations == (mode == 6 ? 1 : 0) && (mode != 0 || samples == 0),"cancellation or desktop/source refusal withholds capture, scrolling and close without replay")
  }
  check(channelMemberCount("View all 1 member") == 1, "a single-member channel is counted")
  for label in ["View all members", "Add people", "View all 26 people", "26 members", "View all -1 members"] {
    check(channelMemberCount(label) == nil, "other avatar-stack labels are not a member count")
  }
  let countTabClasses = ["c-tabs__tab", "c-tabs__tab--active"]
  for (number,expected) in [("0",0),("1",1),("26",26),("0000000",0),("2068",2068),("9999999",9999999),("1,000",1000),("2,068",2068),("1,234,567",1234567),("9,999,999",9999999)] {
    check(channelMemberNumber(number) == expected,"plain and correctly grouped member counts preserve the seven-digit bound")
    check(channelMemberCount("View all \(number) members. Includes Example 99") == expected,"header counts exclude numbers in participant labels")
    check(membersTabCount("Members \(number)") == expected,"the Members tab uses the same complete count grammar")
    check(membersCloseTabMatches("AXRadioButton","members","Members \(number)",countTabClasses,"1",true),"verified grouped member counts retain the selected-tab close guard")
  }
  for number in ["", "1,", ",123", "1,,234", "12,34", "1234,567", "01,234", "0,000", "1,2345", "1,234,56", "10,000,000", "10000000", "1.2k", "2k", "2 068", "+1", "-1", "1.5", "1\n", " 1", "1 ", "\u{0661}\u{0662}\u{0663}"] {
    check(channelMemberNumber(number) == nil,"malformed, abbreviated, partial, non-ASCII and oversized member counts are refused")
    check(channelMemberCount("View all \(number) members. Includes Example") == nil,"invalid header counts cannot become member controls")
    check(membersTabCount("Members \(number)") == nil,"invalid tab counts cannot supply membership totals")
    if number == "2k" {
      check(membersCloseTabMatches("AXRadioButton","members","Members \(number)",countTabClasses,"1",true),"a whole-thousands label can identify the selected tab without supplying a count")
    } else {
      check(!membersCloseTabMatches("AXRadioButton","members","Members \(number)",countTabClasses,"1",true),"invalid tab counts cannot authorize closing a dialog")
    }
  }
  for name in ["Members 1k","Members 11k","Members 13k","Members 9999k"] {
    check(membersRoundedTabLabel(name) && membersTabCount(name) == nil,"whole-thousands tab labels never become exact totals")
    check(membersCloseTabMatches("AXRadioButton","members",name,countTabClasses,"1",true),"rounded labels preserve the same selected-tab structural close guard")
  }
  for name in ["Members 0k","Members 01k","Members 10000k","Members 1.2k","Members 11K","Members 11m","Members 11 k","Members +11k","Members -11k","Members 11k+","Members 11k extra","Members 11k\n"," Members 11k","Members11k","Members \u{FF11}k"] {
    check(!membersRoundedTabLabel(name),"unobserved, partial and malformed rounded labels remain unsupported")
    check(!membersCloseTabMatches("AXRadioButton","members",name,countTabClasses,"1",true),"unsupported rounded labels cannot authorize closing")
  }
  check(membersCountEvidenceMatches(24,"Members 24","Members 24",nil),"an exact tab count remains authoritative without a header")
  check(membersCountEvidenceMatches(10796,"Members 11k","Members 11k",10796),"a rounded tab uses only the independently exposed exact header total")
  check(!membersCountEvidenceMatches(11000,"Members 11k","Members 11k",10796),"the rounded display must never be multiplied into an exact count")
  check(!membersCountEvidenceMatches(10796,"Members 11k","Members 13k",10796),"changed rounded tab text invalidates the retained source")
  check(!membersCountEvidenceMatches(10796,"Members 11k","Members 11k",nil),"rounded membership without exact header evidence is unknown")
  check(!membersCountEvidenceMatches(10796,"Members 11k","Members 11k",10797),"a changed exact header count stops collection")
  check(!membersCountEvidenceMatches(10796,"Members 10.8k","Members 10.8k",10796),"an unsupported abbreviated shape cannot borrow header evidence")
  check(!membersCountEvidenceMatches(24,"Members 24","Members 25",24),"changed exact tab text stops collection even beside an unchanged header")
  check(!membersCountEvidenceMatches(-1,"Members 11k","Members 11k",-1),"invalid negative totals cannot establish rounded count evidence")
  check(channelMemberCount("View 1 member. Includes you.") == 1,"the exact observed self-only singular header is supported")
  for label in ["View 1 member", "View 1 member. Includes you", "View 1 member. Includes Alex.", "View 1 members. Includes you.", "View 2 members. Includes you.", "View 1 member. Includes you. extra"] {
    check(channelMemberCount(label) == nil,"unobserved singular and self-only header variants stay refused")
  }
  for label in ["View all 2,068 members extra", "View all 2,068.5 members", "View all 2,068k members", "View all 2,068 members\n", "prefix View all 2,068 members"] {
    check(channelMemberCount(label) == nil,"complete member-count tokens cannot be extracted from a partial or foreign header")
  }
  let member = ["p-ia_details_popover__members_list_item", "p-ia_details_popover__members_list_item_member", "c-virtual_list__item"]
  check(memberRowMatches("AXGroup","UDEMO123",member) && memberRowMatches("AXGroup","WDEMO123",member), "member rows carry a user ID")
  check(!memberRowMatches("AXGroup","add_member",member) && !memberRowMatches("AXGroup","anchor_hack_item",member), "add-people and anchor rows are not members")
  check(!memberRowMatches("AXGroup","UDEMO123",["p-ia_details_popover__members_list_item"]) && !memberRowMatches("AXButton","UDEMO123",member), "only member list-item groups are member rows")
  let profileClasses = ["c-button-unstyled"]
  let observed = "Alex Example (guest) Agency - Community "
  check(memberLeafProfileLabel("AXButton",profileClasses,0,observed,true) == observed,"a leaf profile retains its complete observed label including trailing spacing")
  for invalid in ["", "   ", "Alex\nExample", "Alex\u{0000}Example", String(repeating:"x",count:2001)] {
    check(memberLeafProfileLabel("AXButton",profileClasses,0,invalid,true) == nil,"missing, multiline, controlled or oversized profile labels are refused")
  }
  check(memberLeafProfileLabel("AXButton",profileClasses,0,"Alex",true) == "Alex","a plain profile label remains a label rather than a guessed name")
  let joinedEmoji = "Alex Example \u{1F469}\u{1F3FB}\u{200D}\u{1F4BB} Community "
  check(memberLeafProfileLabel("AXButton",profileClasses,0,joinedEmoji,true) == joinedEmoji,"a complete profile label preserves joined emoji without inferring a name")
  for scalarValue in Array(0...31) + Array(127...159) {
    let controlled = "Alex" + String(Unicode.Scalar(scalarValue)!) + "Example \u{1F469}\u{1F3FB}\u{200D}\u{1F4BB}"
    check(memberLeafProfileLabel("AXButton",profileClasses,0,controlled,true) == nil,"all C0 and C1 controls remain refused even beside joined emoji")
  }
  for scalarValue in [0x200B, 0x200C, 0x200E, 0x202E, 0x2066, 0xFEFF] {
    let formatted = "Alex" + String(Unicode.Scalar(scalarValue)!) + "Example"
    check(memberLeafProfileLabel("AXButton",profileClasses,0,formatted,true) == formatted,"Unicode format characters are preserved exactly in opaque profile labels, never inferred identity")
  }
  check(memberLeafProfileLabel("AXButton",profileClasses,1,observed,true) == nil,"nonleaf profiles retain the structured-name extraction path")
  check(memberLeafProfileLabel("AXButton",profileClasses,nil,observed,true) == nil,"unknown child inventory cannot establish a leaf profile")
  check(memberLeafProfileLabel("AXGroup",profileClasses,0,observed,true) == nil,"row or group aggregate labels are not profile labels")
  check(memberLeafProfileLabel("AXButton",[],0,observed,true) == nil,"an unknown button layout cannot supply a profile label")
  check(memberLeafProfileLabel("AXButton",profileClasses,0,observed,false) == nil,"a foreign profile button cannot borrow a member row identity")
}
do {
  let url = URL(string:"https://app.slack.com/client/TDEMO123/CDEMO456")!
  let title = "project-alpha (Channel) - Example - Slack"
  let expected = MembersCloseChannel(name:"project-alpha",id:"CDEMO456",url:url.absoluteString)
  for prefix in ["", "! ", "* "] {
    for marker in ["", "#"] {
      check(membersCloseChannel(prefix + title,url,"Details for channel \(marker)project-alpha") == expected,"member close binds both supported exact dialog labels to the canonical channel")
    }
  }
  for bad in ["Details for channel project-beta", "Details for channel #", "Other project-alpha", "Details for channel project-alpha ", "Details for channel project-alpha\n"] {
    check(membersCloseChannel(title,url,bad) == nil,"mismatched or malformed dialog labels cannot authorize close")
  }
  for bad in ["project-alpha (DM) - Example - Slack", "! ! " + title, "other " + title] {
    check(membersCloseChannel(bad,url,"Details for channel project-alpha") == nil,"wrong conversation kind or decorated title cannot authorize close")
  }
  for bad in ["https://example.com/client/TDEMO123/CDEMO456", "http://app.slack.com/client/TDEMO123/CDEMO456", "https://app.slack.com/client/TDEMO123/DDEMO456", "https://app.slack.com/client/TDEMO123/search", "https://app.slack.com/client/TDEMO123/CDEMO456?other=1", "https://app.slack.com/client/TDEMO123/CDEMO456#fragment", "https://app.slack.com/client/TDEMO123/CDEMO456/extra", "https://user@app.slack.com/client/TDEMO123/CDEMO456"] {
    check(membersCloseChannel(title,URL(string:bad)!,"Details for channel project-alpha") == nil,"only an exact canonical channel URL can bind member close")
  }
  check(membersCloseModalMatches("AXGroup","AXApplicationDialog",[],false),"Electron application dialogs are modal blockers even without AXModal")
  check(membersCloseModalMatches("AXGroup","",["c-sk-modal"],false),"Slack modal class independently blocks no-op")
  for nodeRole in ["AXDialog","AXSheet","AXMenu","AXPopover"] {
    check(membersCloseModalMatches(nodeRole,"",[],false),"foreign modal roles remain blockers")
  }
  check(!membersCloseModalMatches("AXGroup","AXTabPanel",["c-tabs__tab_panel"],false),"ordinary panels are not modal blockers")
  let menuClasses = ["c-tabs__tab_menu"]
  for name in ["Details for channel project-alpha", "Details for channel #project-alpha"] {
    check(membersCloseTabGroupMatches("AXTabGroup",name,menuClasses,"project-alpha"),"both observed exact channel tab-group labels are supported")
  }
  for name in ["Details for channel project-beta", "Details for channel ##project-alpha", "Other Details for channel project-alpha", "Details for channel project-alpha\n"] {
    check(!membersCloseTabGroupMatches("AXTabGroup",name,menuClasses,"project-alpha"),"wrong channel, repeated markers and extra label text cannot authorize member close")
  }
  check(!membersCloseTabGroupMatches("AXGroup","Details for channel project-alpha",menuClasses,"project-alpha"),"channel label on a generic group is not a tab menu")
  check(!membersCloseTabGroupMatches("AXTabGroup","Details for channel project-alpha",[],"project-alpha"),"channel label without the known tab-menu class is refused")
  let tabClasses = ["c-tabs__tab", "c-tabs__tab--active"]
  check(membersCloseTabMatches("AXRadioButton","members","Members 24",tabClasses,"1",true),"the observed Members tab must be actively selected")
  check(!membersCloseTabMatches("AXRadioButton","members","Members 24",tabClasses,"0",true),"selected attribute alone cannot replace tab value")
  check(!membersCloseTabMatches("AXRadioButton","members","Members 24",tabClasses,"1",false),"active style/value do not replace selected evidence")
  check(!membersCloseTabMatches("AXButton","members","Members 24",tabClasses,"1",true),"a generic Members button is not the selected tab")
  check(!membersCloseTabMatches("AXRadioButton","settings","Members 24",tabClasses,"1",true),"another tab cannot impersonate Members")
  check(!membersCloseTabMatches("AXRadioButton","members","Members 24",["c-tabs__tab"],"1",true),"inactive tab style stops close")
  for name in ["Members", "Members -1", "Members 24 extra", "Members 24\n"] {
    check(!membersCloseTabMatches("AXRadioButton","members",name,tabClasses,"1",true),"unverified Members tab labels stop close")
  }
  let closeClasses = ["c-button-unstyled","c-icon_button","c-sk-modal__close_button"]
  check(membersCloseButtonMatches("AXButton","Close",closeClasses,true,["AXPress"],true),"only an enabled direct modal Close button is accepted")
  check(!membersCloseButtonMatches("AXButton","Close",closeClasses,false,["AXPress"],true),"disabled modal Close is rejected")
  check(!membersCloseButtonMatches("AXButton","Close",closeClasses,true,[],true),"Close must advertise AXPress")
  check(!membersCloseButtonMatches("AXButton","Close",closeClasses,true,["AXPress"],false),"nested or foreign Close controls are rejected")
  check(!membersCloseButtonMatches("AXButton","Close",["p-flexpane_header__control"],true,["AXPress"],true),"thread Close cannot close a member dialog")
  check(!membersCloseButtonMatches("AXButton","Remove",closeClasses,true,["AXPress"],true),"member mutation controls can never be close targets")
}
do {
  check(directoryMemberCount("89 members") == 89 && directoryMemberCount("1 member") == 1 && directoryMemberCount("1,204 members") == 1204, "directory member counts are parsed")
  for label in ["Unified directory","Unified Directory"] {
    check(directoryViewMatches("AXGroup",label,["p-view_contents--primary"]),"both observed exact directory view labels retain the primary-view boundary")
  }
  for label in ["Unified directory tabs","Unified Directory Tabs"] {
    check(directoryTabsMatch("AXTabGroup",label,["c-tabs__tab_menu"]),"both observed exact directory tab labels retain their tab-menu boundary")
  }
  for label in ["UNIFIED DIRECTORY","Unified DIRECTORY","Unified Directory ","Other Unified Directory","Unified Directory\n"] {
    check(!directoryViewMatches("AXGroup",label,["p-view_contents--primary"]),"unobserved case, partial and decorated view labels remain refused")
  }
  for label in ["UNIFIED DIRECTORY TABS","Unified Directory tabs","Unified Directory Tabs ","Other Unified Directory Tabs","Unified Directory Tabs\n"] {
    check(!directoryTabsMatch("AXTabGroup",label,["c-tabs__tab_menu"]),"unobserved case, partial and decorated tab labels remain refused")
  }
  check(!directoryViewMatches("AXButton","Unified Directory",["p-view_contents--primary"]),"a labelled control cannot replace the directory primary group")
  check(!directoryViewMatches("AXGroup","Unified Directory",[]),"directory text outside the primary view is refused")
  check(!directoryTabsMatch("AXGroup","Unified Directory Tabs",["c-tabs__tab_menu"]),"a generic group cannot replace the directory tab group")
  check(!directoryTabsMatch("AXTabGroup","Unified Directory Tabs",[]),"directory tab text without its known menu class is refused")
  for text in ["members", "89", "Raptor Internal Social", "-", "89 members today"] {
    check(directoryMemberCount(text) == nil, "other directory text is not a member count")
  }
  let result = ["p-explorer_results__contained-result", "c-virtual_list__item"]
  check(directoryChannelRowMatches("AXGroup","CDEMO123",result) && directoryChannelRowMatches("AXGroup","GDEMO123",result), "channel result rows carry a channel ID")
  check(!directoryChannelRowMatches("AXGroup","controls",result) && !directoryChannelRowMatches("AXGroup","education-banner",result) && !directoryChannelRowMatches("AXGroup","DDEMO123",result), "filter, banner and DM rows are not channel results")
  check(directoryPersonInfoID("browse_page_member_info_UDEMO123") == "UDEMO123", "person cards carry a user ID")
  check(directoryPersonInfoID("browse_page_member_info_CDEMO123") == nil && directoryPersonInfoID("UDEMO123") == nil, "only person-card IDs are people")
}
let directForewordAvatar = ForewordNodeShape(role:"AXButton",classes:directForewordClasses,childCount:0)
let groupForewordIntro = ForewordNodeShape(role:"AXStaticText",classes:[],label:"This is the very beginning of your direct message history with ")
let groupForewordEnd = ForewordNodeShape(role:"AXGroup",classes:["p-message_pane__foreword__notification_setting"])
let groupForewordMembers = (1...3).map { index in ForewordNodeShape(role:"AXLink",classes:["c-member_slug","c-member_slug--link"],url:URL(string:"https://example.slack.com/team/UABC\(index)")) }
let groupForewordTail = [groupForewordIntro,groupForewordMembers[0],ForewordNodeShape(role:"AXStaticText",classes:[],label:", "),groupForewordMembers[1],ForewordNodeShape(role:"AXStaticText",classes:[],label:" and "),groupForewordMembers[2],groupForewordEnd]
let directForewordChildren = Array(repeating:directForewordAvatar,count:3) + groupForewordTail
func validGroupForeword(_ children:[ForewordNodeShape] = directForewordChildren, avatars:[ForewordNodeShape] = [], descendants:[ForewordNodeShape] = groupForewordMembers, id:String = "message-list_0000000000.000001", role:String = "AXGroup", classes:[String] = ["c-virtual_list__item"], kind:String = "dm", dmKind:String? = "group") -> Bool {
  isGroupConversationForeword(id,role,classes,children,avatars,descendants,kind,dmKind)
}
check(validGroupForeword(), "exact direct-avatar group history marker is omitted from message timestamps")
do {
  var children = directForewordChildren
  let deletedClasses = directForewordClasses + ["c-avatar--deleted_member"]
  children[0] = ForewordNodeShape(role:"AXButton",classes:deletedClasses,childCount:0)
  check(validGroupForeword(children), "the observed deleted member avatar preserves the exact group welcome structure")
  for extra in ["c-avatar--deleted_member","c-avatar--unknown"] {
    children[0] = ForewordNodeShape(role:"AXButton",classes:deletedClasses+[extra],childCount:0)
    check(!validGroupForeword(children), "duplicate and unknown deleted avatar modifiers remain unsupported")
  }
  children[0] = ForewordNodeShape(role:"AXButton",classes:deletedClasses,childCount:1)
  check(!validGroupForeword(children), "deleted member avatars remain leaf controls")
}
do {
  var children = directForewordChildren
  let focusedClasses = ["c-button--focus-visible"] + directForewordClasses
  children[0] = ForewordNodeShape(role:"AXButton",classes:focusedClasses,childCount:0)
  children[1] = ForewordNodeShape(role:"AXButton",classes:focusedClasses,childCount:0)
  check(validGroupForeword(children), "the observed focus-visible avatars preserve the exact group welcome structure")
  for extra in ["c-button--focus-visible","unverified"] {
    children[0] = ForewordNodeShape(role:"AXButton",classes:focusedClasses+[extra],childCount:0)
    check(!validGroupForeword(children), "duplicate and unknown focus-visible avatar modifiers remain unsupported")
  }
  children[0] = ForewordNodeShape(role:"AXButton",classes:focusedClasses,childCount:1)
  check(!validGroupForeword(children), "focus-visible avatars remain leaf controls")
}
do {
  var children = directForewordChildren
  let focusedClasses = ["c-button--focus-visible"] + directForewordClasses
  let combinedClasses = focusedClasses + ["c-avatar--deleted_member"]
  children[0] = ForewordNodeShape(role:"AXButton",classes:focusedClasses,childCount:0)
  children[1] = ForewordNodeShape(role:"AXButton",classes:combinedClasses,childCount:0)
  check(validGroupForeword(children), "the observed focused deleted member preserves the exact group welcome structure")
  for extra in ["c-button--focus-visible","c-avatar--deleted_member","unverified"] {
    children[1] = ForewordNodeShape(role:"AXButton",classes:combinedClasses+[extra],childCount:0)
    check(!validGroupForeword(children), "duplicate and unknown combined avatar modifiers remain unsupported")
  }
  children[1] = ForewordNodeShape(role:"AXButton",classes:combinedClasses,childCount:1)
  check(!validGroupForeword(children), "focused deleted member avatars remain leaf controls")
}
let wrappedForewordChildren = [ForewordNodeShape(role:"AXGroup",classes:["p-message_pane__foreword__avatars"])] + groupForewordTail
let wrappedForewordAvatars = Array(repeating:ForewordNodeShape(role:"AXButton",classes:["p-message_pane__foreword__avatar"]),count:3)
check(validGroupForeword(wrappedForewordChildren,avatars:wrappedForewordAvatars), "existing wrapped-avatar group history marker remains supported")
check(!validGroupForeword(wrappedForewordChildren), "wrapped layout still requires its observed avatar children")
for avatar in [ForewordNodeShape(role:"AXGroup",classes:directForewordClasses,childCount:0),ForewordNodeShape(role:"AXButton",classes:directForewordClasses,childCount:1),ForewordNodeShape(role:"AXButton",classes:directForewordClasses),ForewordNodeShape(role:"AXButton",classes:Array(directForewordClasses.dropLast()),childCount:0),ForewordNodeShape(role:"AXButton",classes:directForewordClasses+["extra"],childCount:0),ForewordNodeShape(role:"AXButton",classes:Array(directForewordClasses.dropLast())+[directForewordClasses[0]],childCount:0)] {
  var children=directForewordChildren;children[0]=avatar
  check(!validGroupForeword(children), "foreign, nested, incomplete or duplicate-class avatar prefixes refuse omission")
}
for count in [0,1,2,4] {
  check(!validGroupForeword(Array(repeating:directForewordAvatar,count:count)+groupForewordTail), "avatar cardinality must equal the exact member link count")
}
for index in [3,4,5,6,7,8,9] {
  var children=directForewordChildren;children[index]=ForewordNodeShape(role:"AXStaticText",classes:[],label:"unrecognized")
  check(!validGroupForeword(children), "intro, alternating profile grammar and final notification owner are structural proof")
}
for url in ["http://example.slack.com/team/UABC1","https://example.slack.com.evil.test/team/UABC1","https://example.slack.com/team/DABC1","https://example.slack.com/team/UABC1?x=1","https://example.slack.com/team/UABC1#fragment","https://example.slack.com/archives/GABC/p123"] {
  let member=ForewordNodeShape(role:"AXLink",classes:["c-member_slug","c-member_slug--link"],url:URL(string:url))
  var children=directForewordChildren;children[4]=member
  check(!validGroupForeword(children), "only canonical Slack user profile links establish the group preamble")
}
for extra in [ForewordNodeShape(role:"AXLink",classes:[],url:URL(string:"https://example.test")),ForewordNodeShape(role:"AXGroup",classes:["c-message_kit__actions"]),ForewordNodeShape(role:"AXStaticText",classes:["c-timestamp"]),ForewordNodeShape(role:"AXGroup",classes:[],url:URL(string:"https://example.slack.com/archives/GABC/p123"))] {
  check(!validGroupForeword(descendants:groupForewordMembers+[extra]), "message, timestamp, archive and foreign link evidence prevents sentinel omission")
}
check(!validGroupForeword(descendants:Array(groupForewordMembers.dropLast())), "all exact profile links must be exposed")
check(!validGroupForeword(id:"message-list_1730000000.000001"), "real message timestamps never become history metadata")
check(!validGroupForeword(role:"AXStaticText"), "sentinel label alone cannot override row role")
check(!validGroupForeword(classes:[]), "sentinel requires a virtual message-list row")
check(!validGroupForeword(classes:["c-virtual_list__item","c-message_kit__actions"]), "message action row cannot be a foreword")
check(!validGroupForeword(classes:["c-virtual_list__item","c-timestamp"]), "timestamp-bearing row cannot be a foreword")
check(!validGroupForeword(kind:"channel"), "group foreword omission is scoped to a verified DM")
check(!validGroupForeword(dmKind:"one-to-one"), "group layout cannot authorize omission in an individual DM")
check(!validGroupForeword(dmKind:nil), "unknown DM kind cannot authorize group metadata omission")

// Only an exact pre-selection lookup miss can authorize the opt-in fallback.
func lookupMiss(_ query: String, _ exactCount: Int = 0, ambiguous: Bool = false) -> DestinationChoiceFailure {
  DestinationChoiceFailure(query:query, candidates:[], candidateCount:0, ambiguous:ambiguous, exactMatchCount:exactCount)
}
for query in ["Alex", "@alex", " Leading ", String(repeating:"x",count:200), String(repeating:"\u{1f9ed}",count:200)] {
  check(dmFallbackEligible(lookupMiss(query),query,true), "valid exact miss permits opted-in direct lookup")
  check(!dmFallbackEligible(lookupMiss(query),query,false), "clipboard permission is required even for a typed exact miss")
}
check(dmFallbackEligible(lookupMiss("Alex",ambiguous:true),"Alex",true), "multiple inexact suggestions do not imply duplicate exact destinations")
for exactCount in [-1,1,2,3] {
  check(!dmFallbackEligible(lookupMiss("Alex",exactCount),"Alex",true), "only zero exact matches can authorize fallback")
}
for query in ["", " ", "\u{00a0}", String(repeating:"x",count:201), String(repeating:"\u{1f9ed}",count:201), String(repeating:"e\u{0301}",count:101), "Alex\n", "Alex\u{007f}", "Alex\u{009f}"] {
  check(!dmFallbackEligible(lookupMiss(query),query,true), "unsupported direct-search query cannot trigger fallback")
}
check(!dmFallbackEligible(lookupMiss("Casey"),"Alex",true), "lookup error must belong to the exact current query")
check(!dmFallbackEligible(Failure(description:"No exact DM destination matched; Return withheld"),"Alex",true), "error text cannot impersonate a typed pre-selection miss")
enum UnrelatedLookupFailure: Error { case expected }
check(!dmFallbackEligible(UnrelatedLookupFailure.expected,"Alex",true), "arbitrary navigation or verification errors cannot trigger fallback")

let personCases: [(String,String,String?,String,Bool)] = [
  ("person","Alex","alex","Alex",true),
  ("person","Alex",nil,"Alex",true),
  ("person","Alex","alex","@alex",true),
  ("person"," Leading ",nil," Leading ",true),
  ("person","Alex",nil,"@alex",false),
  ("person","Alex","alex","alex",false),
  ("person","Alex","alex","Al",false),
  ("person","Alex","alex","alexander",false),
  ("person","Alex","alex","@Alex",false),
  ("person","Alex","alex","@al",false),
  ("person","Alex","alex","@alexander",false),
  ("person","Alex","@alex","@alex",false),
  ("person","@alex",nil,"@alex",false),
  ("person","Alex","casey","@alex",false),
  ("person","Alex",nil,"Alex ",false),
  ("person","Alex",nil," Alex",false),
  ("person","Alex",nil,"alex",false),
  ("group","Alex",nil,"Alex",false),
  ("group","Alex","alex","@alex",false),
  ("one-to-one","Alex","alex","Alex",false),
  ("","Alex","alex","Alex",false)
]
for (kind,name,handle,query,expected) in personCases {
  check(dmPersonMatches(kind,name,handle,query) == expected, "person matching preserves exact kind, name and observed-handle semantics")
}

check(individualSidebarControl("AXGroup",["p-channel_sidebar__channel","p-channel_sidebar__channel--show-avatars"]), "observed individual sidebar control accepted")
do {
  let name = "Example Person"
  let identifier = "DDEMO123"
  let controlClasses = ["p-channel_sidebar__channel","p-channel_sidebar__channel--draft","p-channel_sidebar__channel--show-avatars"]
  let passive = ["AXShowMenu","AXScrollToVisible"]
  let fixture: [Int:IndividualSidebarNode<Int>] = [
    0: IndividualSidebarNode(role:"AXRow",id:identifier,classes:[],parent:99,children:[1],actions:["AXPress"],focused:false,enabled:true),
    1: IndividualSidebarNode(role:"AXGroup",id:"",classes:controlClasses,parent:0,children:[2,3,4],actions:["AXPress"]+passive,focused:false,enabled:true),
    2: IndividualSidebarNode(role:"AXGroup",id:"",classes:["p-channel_sidebar__user_avatar"],parent:1,children:[5,6],actions:passive,focused:false,enabled:true),
    3: IndividualSidebarNode(role:"AXStaticText",id:"",classes:[],parent:1,children:[],actions:passive,focused:false,enabled:true,labels:[name,nil,name]),
    4: IndividualSidebarNode(role:"AXStaticText",id:"",classes:[],parent:1,children:[],actions:passive,focused:false,enabled:true,labels:["Example Organization",nil,"Example Organization"]),
  ]
  check(sidebarDMIdentity(identifier,controlClasses,true,[name,"Example Organization"]) == nil,"generic sidebar identity parsing remains strict about unknown secondary labels")
  var reads: [Int] = []
  let proof = individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{ reads.append($0); return fixture[$0]! })
  check(proof != nil,"a previously verified individual DM can retain an opaque secondary sidebar label")
  check(reads == [0,1,2,3,4],"supplementary proof reads only its row, control, avatar and two passive leaves")
  check(proof?.nodes[3].text == name && proof?.nodes[4].text == "Example Organization","the exact name and opaque extra stay separate in the retained proof")
  for rows in [[Int](),[0,0],[0,9]] {
    var reads = 0
    check(individualSidebarSupplement(rows,identifier:identifier,name:name,existing:nil,read:{ reads += 1; return fixture[$0]! }) == nil && reads == 0,"zero or duplicate canonical rows cannot enter the supplementary route")
  }
  for id in ["CDEMO123","DOTHER123","DDEMO123\n",""] {
    check(individualSidebarSupplement([0],identifier:id,name:name,existing:nil,read:{fixture[$0]!}) == nil,"only the exact independently captured canonical D-ID can bind the row")
  }
  for existing in [SidebarDM(name:name,kind:"one-to-one"),SidebarDM(name:"Other",kind:"one-to-one"),SidebarDM(name:name,kind:"group"),SidebarDM(name:name,kind:"self")] {
    check(individualSidebarSupplement([0],identifier:identifier,name:name,existing:existing,read:{fixture[$0]!}) == nil,"supplementary labels never replace or override an already parsed sidebar identity")
  }
  check(individualSidebarSupplement([0],identifier:identifier,name:"",existing:nil,read:{fixture[$0]!}) == nil,"a missing previously verified name cannot authorize the supplementary route")
  for mutation in 0..<41 {
    var changed = fixture
    switch mutation {
    case 0: changed[0]!.role = "AXGroup"
    case 1: changed[0]!.id = "DOTHER123"
    case 2: changed[0]!.children = [1,1]
    case 3: changed[1]!.parent = 99
    case 4: changed[1]!.role = "AXButton"
    case 5: changed[1]!.classes!.append("p-channel_sidebar__channel--mpim")
    case 6: changed[1]!.classes = ["p-channel_sidebar__channel"]
    case 7: changed[1]!.children = [2,3,4,5]
    case 8: changed[1]!.children = [2,3,3]
    case 9: changed[1]!.children = [2,4,3]
    case 10: changed[2]!.parent = 99
    case 11: changed[2]!.classes = ["unknown-avatar"]
    case 12: changed[2]!.role = "AXButton"
    case 13: changed[2]!.focused = true
    case 14: changed[2]!.actions = ["AXPress"]
    case 15: changed[3]!.parent = 99
    case 16: changed[3]!.role = "AXTextArea"
    case 17: changed[3]!.children = [5]
    case 18: changed[3]!.classes = ["unknown-text"]
    case 19: changed[3]!.focused = true
    case 20: changed[3]!.enabled = false
    case 21: changed[3]!.actions = nil
    case 22: changed[4]!.role = "AXButton"
    case 23: changed[4]!.focused = true
    case 24: changed[4]!.parent = 99
    case 25: changed[4]!.children = [5]
    case 26: changed[4]!.classes = ["unknown-text"]
    case 27: changed[1]!.focused = true
    case 28: changed[1]!.enabled = false
    case 29: changed[1]!.actions = passive
    case 30: changed[2]!.focused = nil
    case 31: changed[3]!.labels = ["Other Person"]
    case 32: changed[0]!.children = nil
    case 33: changed[1]!.children = nil
    case 34: changed[3]!.children = nil
    case 35: changed[4]!.children = nil
    case 36: changed[4]!.id = "foreign"
    case 37: changed[1]!.id = "foreign"
    case 38: changed[2]!.id = "foreign"
    case 39: changed[1]!.classes!.append("p-channel_sidebar__channel--im-you")
    default: changed[1]!.actions!.append("AXConfirm")
    }
    check(individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{changed[$0]!}) == nil,"foreign, ambiguous, changed-name, interactive or unsupported supplementary structures are refused")
  }
  for extra in ["","   ",name,"guest","you","Example\u{0000}Organization","Example\nOrganization",String(repeating:"x",count:501)] {
    var changed = fixture; changed[4]!.labels = [extra]
    check(individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{changed[$0]!}) == nil,"extra labels must be bounded, opaque, nonblank and distinct from the verified name and reserved markers")
  }
  check(individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{fixture[$0]!}) == proof,"an unchanged fresh capture retains every source identity and observed field")
  for replaced in [1,2,4] {
    var changed = fixture; changed[8] = changed[replaced]
    if replaced == 1 {
      changed[0]!.children = [8]
      for child in [2,3,4] { changed[child]!.parent = 8 }
    } else {
      changed[1]!.children = [2,3,4].map { $0 == replaced ? 8 : $0 }
    }
    let fresh = individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{changed[$0]!})
    check(fresh != nil && fresh != proof,"replacement control, avatar and leaf identities fail the retained pre-press equality proof")
  }
  for labels in [["Other Organization",nil,"Other Organization"],["Example Organization",nil,"changed raw value"]] as [[String?]] {
    var changed = fixture; changed[4]!.labels = labels
    let fresh = individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{changed[$0]!})
    check(fresh != nil && fresh != proof,"any captured secondary label field change fails the retained pre-press equality proof")
  }
  var changedDraft = fixture; changedDraft[1]!.classes!.removeAll { $0 == "p-channel_sidebar__channel--draft" }
  let changedDraftProof = individualSidebarSupplement([0],identifier:identifier,name:name,existing:nil,read:{changedDraft[$0]!})
  check(changedDraftProof != nil && changedDraftProof != proof,"a changed draft marker fails fresh equality without reading or editing the draft")
}
for (role, classes) in [("AXRow",["p-channel_sidebar__channel","p-channel_sidebar__channel--show-avatars"]),
  ("AXButton",["p-channel_sidebar__channel","p-channel_sidebar__channel--show-avatars"]),
  ("AXGroup",["p-channel_sidebar__channel"]), ("AXGroup",["p-channel_sidebar__channel--show-avatars"]),
  ("AXGroup",["p-channel_sidebar__channel","p-channel_sidebar__channel--show-avatars","p-channel_sidebar__channel--mpim"]),
  ("AXGroup",[])] {
  check(!individualSidebarControl(role,classes), "unsupported or group sidebar control rejected")
}
var incompleteMiss = lookupMiss("Alex")
incompleteMiss.incomplete = true
check(!dmFallbackEligible(incompleteMiss,"Alex",true), "incomplete evidence never recurses into fallback")
var routeCalls: [String] = []
let normalRead: String = try resolveIndividualDM("Alex", allowClipboard:true,
  primaryLookup: { routeCalls.append("primary"); return "normal" },
  directLookup: { routeCalls.append("direct"); return "fallback" })
check(normalRead == "normal" && routeCalls == ["primary"], "normal success performs no direct search")
routeCalls = []
let directRead: String = try resolveIndividualDM("Alex", allowClipboard:true,
  primaryLookup: { routeCalls.append("primary"); throw lookupMiss("Alex") },
  directLookup: { routeCalls.append("direct"); return "fallback" })
check(directRead == "fallback" && routeCalls == ["primary","direct"], "typed miss invokes direct lookup exactly once")
for (allowed, error): (Bool, Error) in [(false,lookupMiss("Alex")), (true,lookupMiss("Alex",2)),
  (true,Failure(description:"Submission attempted once")), (true,lookupMiss("Other")), (true,incompleteMiss)] {
  routeCalls = []
  do {
    let _: String = try resolveIndividualDM("Alex",allowClipboard:allowed,
      primaryLookup:{ routeCalls.append("primary"); throw error },
      directLookup:{ routeCalls.append("direct"); return "unexpected" })
    fatalError("ineligible failure accepted")
  } catch { check(routeCalls == ["primary"], "guard and ambiguity failures propagate without fallback") }
}
routeCalls = []
do {
  let _: String = try resolveIndividualDM("Alex",allowClipboard:true,
    primaryLookup:{ routeCalls.append("primary"); throw lookupMiss("Alex") },
    directLookup:{ routeCalls.append("direct"); throw Failure(description:"direct failed") })
  fatalError("direct failure accepted")
} catch { check(routeCalls == ["primary","direct"], "direct failure is never replayed or returned to primary") }

// A UUID-named pasteboard exercises the real preservation API without ever
// reading or writing the user's general clipboard or invoking Slack.
func checkDMQueryClipboard() throws {
  let board = NSPasteboard(name:NSPasteboard.Name("org.slack-desktop.native-tests.\(UUID().uuidString)"))
  defer { board.releaseGlobally() }
  func snapshot() -> [[String:Data]] {
    (board.pasteboardItems ?? []).map { item in
      Dictionary(uniqueKeysWithValues:item.types.map { type in
        guard let data = item.data(forType:type) else { fatalError("test pasteboard representation unavailable") }
        return (type.rawValue,data)
  })
}
  }
  let binaryType = NSPasteboard.PasteboardType("org.slack-desktop.native-test.binary")
  let first = NSPasteboardItem(), second = NSPasteboardItem()
  check(first.setString("Original first \u{1f9ed}",forType:.string), "first clipboard item initialized")
  check(first.setData(Data([0,255,128,1,0]),forType:binaryType), "binary clipboard representation initialized")
  check(second.setString("Original second",forType:.string), "second clipboard item initialized")
  check(second.setData(Data("<b>Original</b>".utf8),forType:.html), "HTML clipboard representation initialized")
  _ = board.prepareForNewContents(with:[.currentHostOnly])
  check(board.writeObjects([first,second]), "isolated multi-item clipboard initialized")
  let original = snapshot()
  check(original.count == 2 && original[0].count == 2 && original[1].count == 2, "fixture contains multiple ordered items and types")
  let result = try withDMQueryClipboard("Leah \u{1f9ed}",board:board) { owns in
    check(board.string(forType:.string) == "Leah \u{1f9ed}" && board.pasteboardItems?.count == 1, "temporary query is the only leased item")
    try owns()
    check(true, "unchanged temporary clipboard passes ownership check")
    return 17
  }
  check(result == 17, "clipboard lease returns body result")
  check(snapshot() == original, "all original item/type bytes restored after success")
  check(clipboardRestoration == "restored", "successful restoration reported")
  enum BodyFailure: Error { case expected }
  do {
    try withDMQueryClipboard("Casey",board:board) { owns in
      try owns()
      throw BodyFailure.expected
    }
    fatalError("throwing clipboard body did not propagate")
  } catch BodyFailure.expected { count += 1 }
  check(snapshot() == original, "all representations restored after throwing body")
  check(clipboardRestoration == "restored", "throwing body still reports completed restoration")

  let newer = NSPasteboardItem()
  check(newer.setData(Data([9,0,254,10]),forType:binaryType), "simulated newer copy contains distinct binary bytes")
  var newerSnapshot:[[String:Data]] = []
  do {
    try withDMQueryClipboard("Leah",board:board) { owns in
      _ = board.prepareForNewContents(with:[.currentHostOnly])
      check(board.writeObjects([newer]), "simulated external copy replaces temporary query")
      newerSnapshot = snapshot()
      try owns()
      fatalError("ownership callback accepted a newer copy")
    }
    fatalError("lost clipboard ownership did not propagate")
  } catch let error as Failure {
    check(error.description == "Clipboard changed before paste; paste withheld", "ownership failure reaches caller before paste")
  }
  check(snapshot() == newerSnapshot && newerSnapshot != original, "newer copy survives lease cleanup byte-for-byte")
  check(clipboardRestoration == "newer-copy-preserved", "contended clipboard reports preserved newer copy")
  _ = board.prepareForNewContents(with:[.currentHostOnly])
  check(snapshot().isEmpty, "empty clipboard fixture initialized")
  try withDMQueryClipboard("Empty board query",board:board) { owns in
    try owns()
    check(board.string(forType:.string) == "Empty board query", "empty clipboard accepts temporary query")
  }
  check(snapshot().isEmpty, "original empty clipboard restored")
  check(clipboardRestoration == "restored", "empty clipboard restoration verified")
}
func rejectWorkspace(_ body: () throws -> Void) {
  do { try body(); fatalError("unsafe workspace proof accepted") } catch { count += 1 }
}
for (raw, expected) in [("https://app.slack.com/client/TONE/CCHAN", "TONE"), ("https://app.slack.com/client/EORG", "EORG"), ("https://app.slack.com/client/TONE?view=home", "TONE")] {
  check(try workspaceContext(raw) == expected, "canonical workspace context is observed without guessing team IDs")
}
for raw in ["http://app.slack.com/client/TONE", "https://evil.test/client/TONE", "https://app.slack.com.evil.test/client/TONE", "https://user@app.slack.com/client/TONE", "https://app.slack.com:443/client/TONE", "https://app.slack.com/client/TONE#fragment", "https://app.slack.com/client/T", "https://app.slack.com/client/tone", "https://app.slack.com/client/%54ONE", "https://app.slack.com/other/TONE"] {
  rejectWorkspace { _ = try workspaceContext(raw) }
}
for name in ["Workspace One", "R\u{e9}sum\u{e9}", "Team 🧭", String(repeating:"a",count:200)] {
  check(validWorkspaceName(name), "bounded exact workspace names are preserved")
}
for name in ["", " leading", "trailing ", "line\nfeed", "bidi\u{202E}", String(repeating:"a",count:201)] {
  check(!validWorkspaceName(name), "unsafe workspace target name is refused")
}
for domain in ["one.slack.com", "one-two.slack.com", "one.enterprise.slack.com"] {
  check(validWorkspaceDomain(domain), "observed canonical domain is a supported reference")
}
for domain in ["ONE.slack.com", "one.slack.com.evil.test", "one.slack.com/", "https://one.slack.com", "u@one.slack.com", "one.slack.com:443", "one..slack.com", "-one.slack.com", "one.slack.com\n"] {
  check(!validWorkspaceDomain(domain), "foreign and noncanonical workspace domains are refused")
}
let workspaceRows = [WorkspaceRow(name:"One",domain:"one.slack.com",current:true), WorkspaceRow(name:"Two",domain:"two.slack.com",current:false)]
do {
  let base = ["c-button-unstyled","p-account_switcher"]
  let styled = ["c-button--focus-visible"] + base
  for names in [base,Array(base.reversed()),styled,Array(styled.reversed())] {
    check(workspaceSwitcherShapeMatches("AXPopUpButton",names,enabled:true,hasURL:false),
      "the exact account switcher supports its observed optional focus style in either class order")
  }
  for role in ["AXButton","AXRadioButton","AXGroup",""] {
    check(!workspaceSwitcherShapeMatches(role,styled,enabled:true,hasURL:false),
      "focus styling cannot turn another role into the workspace pop-up control")
  }
  check(!workspaceSwitcherShapeMatches("AXPopUpButton",styled,enabled:false,hasURL:false),
    "a disabled styled account switcher remains refused")
  check(!workspaceSwitcherShapeMatches("AXPopUpButton",styled,enabled:true,hasURL:true),
    "a link-bearing styled account switcher remains refused")
  for names in [[],[base[0]],[base[1]],["c-button--focus-visible"],base+["unknown"],
    styled+["unknown"],base+[base[0]],styled+["c-button--focus-visible"],
    ["c-button--focus-visible","p-account_switcher"]] {
    check(!workspaceSwitcherShapeMatches("AXPopUpButton",names,enabled:true,hasURL:false),
      "missing, foreign and duplicate account-switcher classes stay refused")
  }
  check(workspaceMatches(workspaceRows,"Two 19 new mentions","TONE").isEmpty,
    "mention-like suffixes are not stripped from requested workspace identities")
  check(workspaceMatches(workspaceRows,"Switch workspaces\u{2026} (Two) 19 new mentions","TONE").isEmpty,
    "the switcher announcement cannot replace an exact observed workspace name")
}
try validateWorkspaceRows(workspaceRows, "One"); count += 1
for rows in [[], [workspaceRows[0],workspaceRows[0]], [WorkspaceRow(name:"One",domain:"one.slack.com",current:false)], [workspaceRows[0],WorkspaceRow(name:"Two",domain:"two.slack.com",current:true)], [WorkspaceRow(name:"Wrong",domain:"one.slack.com",current:true)], [WorkspaceRow(name:"One",domain:"evil.test",current:true)], [WorkspaceRow(name:"One\n",domain:"one.slack.com",current:true)], (0..<65).map { WorkspaceRow(name:"One",domain:"team\($0).slack.com",current:$0 == 0) }] {
  rejectWorkspace { try validateWorkspaceRows(rows, "One") }
}
check(workspaceMatches(workspaceRows,"workspace:two.slack.com","TONE") == [workspaceRows[1]], "domain reference matches only its observed row")
check(workspaceMatches(workspaceRows,"Two","TONE") == [workspaceRows[1]], "exact unique name matches")
check(workspaceMatches(workspaceRows,"two","TONE").isEmpty, "workspace names are not fuzzy matched")
check(workspaceMatches(workspaceRows,"TONE","TONE") == [workspaceRows[0]], "only current observed context can resolve by ID")
do {
  // Workspace rail: names only, no domains, never opened or closed.
  let railRows = [WorkspaceRow(name:"One",domain:nil,current:true), WorkspaceRow(name:"Two Team",domain:nil,current:false)]
  try validateWorkspaceRows(railRows, "One"); count += 1
  rejectWorkspace { try validateWorkspaceRows([railRows[0], workspaceRows[1]], "One") }
  check(workspaceMatches(railRows,"Two Team","TONE") == [railRows[1]], "rail rows match by exact unique name")
  check(workspaceMatches(railRows,"workspace:two.slack.com","TONE").isEmpty, "rail rows never satisfy a domain reference")
  check(workspaceMatches(railRows + [WorkspaceRow(name:"Two Team",domain:nil,current:false)],"Two Team","TONE").count == 2, "same-name rail rows remain ambiguous")
  check(railRows[1].receipt["domain"] is NSNull, "a rail row reports its domain as unknown")
  let item = ["c-button-unstyled","p-team_sidebar__item"]
  func entry(_ role:String = "AXRadioButton", _ classes:[String] = item, _ value:String? = "0", _ label:String = "Two Team", _ icons:[String] = ["Two Team"], _ enabled:Bool = true, _ hasURL:Bool = false) -> (name:String,current:Bool)? {
    workspaceRailEntry(role:role,classes:classes,value:value,label:label,iconLabels:icons,enabled:enabled,hasURL:hasURL)
  }
  check(entry().map { $0.name == "Two Team" && !$0.current } == true, "an inactive rail button yields its icon name")
  check(entry("AXRadioButton", item + ["p-team_sidebar__item--active"], "1").map { $0.current } == true, "the active class and value mark the current workspace")
  for label in ["Two Team 4", "Two Team 26", "Two Team 99+"] {
    check(entry("AXRadioButton", item, "0", label)?.name == "Two Team", "an appended unread count does not change the workspace name")
  }
  for label in ["Two Team extra", "Two Teams", "Other", "Two Team -1", ""] {
    check(entry("AXRadioButton", item, "0", label) == nil, "a button label must be the icon name with at most a count")
  }
  check(entry("AXButton") == nil && entry("AXRadioButton", ["c-button-unstyled"]) == nil, "only rail radio buttons are workspace entries")
  check(entry("AXRadioButton", item, "1") == nil && entry("AXRadioButton", item + ["p-team_sidebar__item--active"], "0") == nil, "an inconsistent current marker is refused")
  check(entry("AXRadioButton", item, "0", "Two Team", []) == nil && entry("AXRadioButton", item, "0", "Two Team", ["Two Team","Two Team"]) == nil, "exactly one icon name is required")
  check(entry("AXRadioButton", item, "0", "Two Team", ["Two Team"], false) == nil && entry("AXRadioButton", item, "0", "Two Team", ["Two Team"], true, true) == nil, "disabled or link-bearing buttons are refused")
}
check(workspaceMatches(workspaceRows + [WorkspaceRow(name:"TFOREIGN",domain:"foreign.slack.com",current:false)],"TFOREIGN","TONE").isEmpty, "foreign ID-shaped names cannot bypass context matching")
check(workspaceMatches(workspaceRows + [WorkspaceRow(name:"workspace:unknown.slack.com",domain:"third.slack.com",current:false)],"workspace:unknown.slack.com","TONE").isEmpty, "reserved reference syntax cannot become a display-name alias")
check(workspaceMatches(workspaceRows + [WorkspaceRow(name:"Two",domain:"third.slack.com",current:false)],"Two","TONE").count == 2, "same-name workspaces remain ambiguous")
let workspaceBaseClasses = ["c-button-unstyled","p-team_switcher_menu__item","c-menu_item__button"]
check(try workspaceChecked(workspaceBaseClasses,"0") == false, "unchecked class and value agree")
check(try workspaceChecked(workspaceBaseClasses + ["c-menu_item__button--checked"],"1"), "checked class and value agree")
do {
  let focus = "c-button--focus-visible"
  let marker = "c-menu_item__button--checked"
  let styled = [focus] + workspaceBaseClasses
  for current in [false,true] {
    let names = styled + (current ? [marker] : [])
    let value = current ? "1" : "0"
    check(try workspaceChecked(names,value) == current,
      "observed focus styling preserves the exact checked class and value agreement")
    check(try workspaceChecked(Array(names.reversed()),value) == current,
      "focus-styled workspace marker classes remain order independent")
    for invalid: String? in [nil,"",current ? "0" : "1","true","false","01","1 "] {
      rejectWorkspace { _ = try workspaceChecked(names,invalid) }
    }
  }
  for names in [styled+["unknown"],styled+["p-team_switcher_menu__item--add"],
    styled+[workspaceBaseClasses[0]],styled+[focus],
    [focus]+Array(workspaceBaseClasses.dropFirst()),styled+[marker,marker],[focus],[]] {
    rejectWorkspace { _ = try workspaceChecked(names,names.contains(marker) ? "1" : "0") }
  }
  let additionBase = workspaceBaseClasses + ["p-team_switcher_menu__item--add"]
  let additionStyled = [focus] + additionBase
  for names in [additionBase,additionStyled,Array(additionStyled.reversed())] {
    check(workspaceAdditionMatches("AXMenuItem",names,"Add a workspace","",index:3,count:4,enabled:true,hasURL:false),
      "the terminal addition inventory row supports only its exact observed optional focus style")
  }
  for size in [2,65] {
    check(workspaceAdditionMatches("AXMenuItem",additionStyled,"Add a workspace","",index:size-1,count:size,enabled:true,hasURL:false),
      "addition remains the terminal inventory row within existing menu bounds")
  }
  for mutation in 0..<16 {
    var role = "AXMenuItem", names = additionStyled, label = "Add a workspace"
    var value: String? = ""
    var index = 3, size = 4
    var enabled = true, hasURL = false
    switch mutation {
    case 0: role = "AXButton"
    case 1: label = "Join a workspace"
    case 2: value = nil
    case 3: value = "0"
    case 4: index = 0
    case 5: size = 1; index = 0
    case 6: size = 66; index = 65
    case 7: enabled = false
    case 8: hasURL = true
    case 9: names.append("unknown")
    case 10: names.append(focus)
    case 11: names.removeAll {$0 == "p-team_switcher_menu__item--add"}
    case 12: names.append(marker)
    case 13: names.append(workspaceBaseClasses[0])
    case 14: label = ""
    default: label += " "
    }
    check(!workspaceAdditionMatches(role,names,label,value,index:index,count:size,enabled:enabled,hasURL:hasURL),
      "addition requires exact role, class inventory, terminal position, label, empty value and enabled URL-free state")
  }
}
for (classes,value) in [(workspaceBaseClasses,"1" as String?), (workspaceBaseClasses + ["c-menu_item__button--checked"],"0"), (workspaceBaseClasses,nil), (workspaceBaseClasses,"true"), (workspaceBaseClasses + ["p-team_switcher_menu__item--add"],"0"), (workspaceBaseClasses + ["unknown"],"0"), (workspaceBaseClasses + [workspaceBaseClasses[0]],"0")] {
  rejectWorkspace { _ = try workspaceChecked(classes,value) }
}
let workspaceBefore = WorkspaceView(url:"https://app.slack.com/client/EONE/CONE",name:"One",windowId:12)
let workspaceAfter = WorkspaceView(url:"https://app.slack.com/client/TTWO/CTWO",name:"Two",windowId:12)
let workspaceAfterRows = [WorkspaceRow(name:"One",domain:"one.slack.com",current:false), WorkspaceRow(name:"Two",domain:"two.slack.com",current:true)]
try verifyWorkspaceTransition(workspaceBefore,workspaceAfter,workspaceRows,workspaceAfterRows,workspaceRows[1]); count += 1
try verifyWorkspaceTransition(workspaceBefore,workspaceBefore,workspaceRows,workspaceRows,workspaceRows[0]); count += 1
for (after, rows, selected) in [(WorkspaceView(url:workspaceAfter.url,name:"Two",windowId:13), workspaceAfterRows,workspaceRows[1]), (WorkspaceView(url:workspaceBefore.url,name:"Two",windowId:12),workspaceAfterRows,workspaceRows[1]), (workspaceAfter,Array(workspaceAfterRows.reversed()),workspaceRows[1]), (workspaceAfter,[WorkspaceRow(name:"One",domain:"one.slack.com",current:false),WorkspaceRow(name:"Two",domain:"foreign.slack.com",current:true)],workspaceRows[1]), (workspaceAfter,[workspaceAfterRows[1]],workspaceRows[1]), (workspaceAfter,workspaceAfterRows,WorkspaceRow(name:"Fake",domain:"fake.slack.com",current:false)), (workspaceAfter,workspaceAfterRows,workspaceRows[0]), (workspaceAfter,workspaceRows,workspaceRows[1])] {
  rejectWorkspace { try verifyWorkspaceTransition(workspaceBefore,after,workspaceRows,rows,selected) }
}
try verifyWorkspaceSelectorClosure(workspaceBefore,workspaceBefore,workspaceRows,workspaceRows,sameControl:true,sameMenu:true); count += 1
for (view, rows, sameControl, sameMenu) in [(WorkspaceView(url:"https://app.slack.com/client/EONE/COTHER",name:"One",windowId:12),workspaceRows,true,true), (WorkspaceView(url:workspaceBefore.url,name:"Other",windowId:12),workspaceRows,true,true), (WorkspaceView(url:workspaceBefore.url,name:"One",windowId:13),workspaceRows,true,true), (workspaceBefore,workspaceRows,false,true), (workspaceBefore,workspaceRows,true,false), (workspaceBefore,[workspaceRows[0],WorkspaceRow(name:"Two",domain:"other.slack.com",current:false)],true,true)] {
  rejectWorkspace { try verifyWorkspaceSelectorClosure(workspaceBefore,view,workspaceRows,rows,sameControl:sameControl,sameMenu:sameMenu) }
}
for (focused, allowed) in [([graphHandles[0]],true),([graphHandles[1]],true),([graphHandles[2]],true),([graphHandles[3]],false),([],false),([graphHandles[0],graphHandles[1]],false),([graphHandles[0],graphHandles[7]],false),([graphHandles[1],graphHandles[2]],false)] {
  check(workspaceSelectorFocusMatches(focused,control:graphHandles[0],menu:graphHandles[1],rows:[graphHandles[2]]) == allowed, "only one retained popup, menu or direct workspace row can own Escape focus")
}
func rejectedWorkspaceEscape(_ body: () throws -> Void) -> Bool {
  do { try body(); return false } catch { return true }
}
do {
  var trace:[String] = []
  var now = Date(timeIntervalSince1970:100)
  let deadline = Date(timeIntervalSince1970:101)
  var cancelled = false
  try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify")},down:{trace.append("down")},up:{trace.append("up")},wait:{trace.append("wait");cancelled=true;now=deadline})
  check(trace == ["verify","down","wait","up"], "targeted Escape posts one down and guaranteed up even if cancellation and expiry follow down")
  trace=[];now=deadline;cancelled=false
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify")},down:{trace.append("down")},up:{trace.append("up")},wait:{}) } && trace.isEmpty, "expired Escape does not start preflight or input")
  trace=[];now=Date(timeIntervalSince1970:100);cancelled=true
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify")},down:{trace.append("down")},up:{trace.append("up")},wait:{}) } && trace.isEmpty, "cancelled Escape does not start preflight or input")
  trace=[];cancelled=false
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify");now=deadline},down:{trace.append("down")},up:{trace.append("up")},wait:{}) } && trace == ["verify"], "slow verification cannot post Escape after deadline")
  trace=[];now=Date(timeIntervalSince1970:100)
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify");cancelled=true},down:{trace.append("down")},up:{trace.append("up")},wait:{}) } && trace == ["verify"], "cancellation during verification withholds Escape")
  trace=[];cancelled=false
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify");throw Failure(description:"guard")},down:{trace.append("down")},up:{trace.append("up")},wait:{}) } && trace == ["verify"], "failed focus/window/modal/physical-input preflight withholds all key events")
  trace=[]
  check(rejectedWorkspaceEscape { try postWorkspaceEscape(deadline:deadline,now:{now},interrupted:{cancelled},preflight:{trace.append("verify")},down:{trace.append("down")},up:{trace.append("up")},wait:{trace.append("wait");throw Failure(description:"interrupted")}) } && trace == ["verify","down","wait","up"], "throw after key-down releases the key before propagating failure without retry")
}
try requireWorkspaceClosePermission(true); count += 1
rejectWorkspace { try requireWorkspaceClosePermission(false) }
let scopedWorkspaceTarget = "workspace:two.slack.com"
for command in ["channels","dms","search","channel","read-channel","read-dm","read-thread","read-media","read-transcript","save-media"] {
  let arguments = [command,"literal"]
  let scoped = try workspaceArguments(["--workspace=" + scopedWorkspaceTarget] + arguments)
  check(scoped.0 == scopedWorkspaceTarget && scoped.1 == arguments, "workspace prefix selects one target without changing requested command arguments")
  let foreground = try workspaceArguments(["--interaction=foreground","--workspace=" + scopedWorkspaceTarget] + arguments)
  check(foreground.0 == scopedWorkspaceTarget && foreground.1 == ["--interaction=foreground"] + arguments, "workspace prefix follows optional interaction without authorizing another mode")
  let literal = [command,"--workspace=literal"]
  let unchanged = try workspaceArguments(literal)
  check(unchanged.0 == nil && unchanged.1 == literal, "flag-like positional text does not request workspace selection")
}
for arguments in [["--workspace=One","inspect"], ["--workspace=One","permissions"], ["--workspace=One","workspaces"], ["--workspace=One","current-workspace"], ["--workspace=One","switch-workspace","Two"], ["--workspace=One","--help"], ["--workspace=One"], ["--workspace=","channels"], ["--workspace=  ","channels"], ["--workspace=One\n","channels"], ["--workspace=" + String(repeating:"a",count:201),"channels"], ["--workspace","One","channels"], ["--workspace=One","--workspace=Two","channels"], ["--workspace=One","--interaction=foreground","channels"], ["--interaction=background","--workspace=One","--workspace=Two","channels"]] {
  rejectWorkspace { _ = try workspaceArguments(arguments) }
}
let scopedMediaArguments = try workspaceArguments(["--interaction=foreground","--workspace=One","read-media","FFILE"])
rejectWorkspace { _ = try interactionArguments(scopedMediaArguments.1) }
for mode in ["background","foreground"] {
  let scoped = try workspaceArguments(["--interaction="+mode,"--workspace="+scopedWorkspaceTarget,"save-media","FFILE"])
  let parsed = try interactionArguments(scoped.1)
  check(parsed.0 == (mode == "foreground" ? .foreground : .background) && parsed.1 == ["save-media","FFILE"], "scoped saves preserve the explicit interaction mode and attachment reference")
}
let scopedDefaultSave = try workspaceArguments(["--workspace="+scopedWorkspaceTarget,"save-media","FFILE"])
check(try interactionArguments(scopedDefaultSave.1).0 == .background, "scoped saves keep background interaction as default")
for arguments in [["--workspace=","save-media","FFILE"],["--workspace= ","save-media","FFILE"],["--workspace=One\n","save-media","FFILE"],["--workspace","One","save-media","FFILE"],["--workspace=One","--workspace=Two","save-media","FFILE"],["--workspace=One","--interaction=foreground","save-media","FFILE"]] {
  rejectWorkspace { _ = try workspaceArguments(arguments) }
}
do {
  var evidence = WorkspaceSelectionEvidence(requested:scopedWorkspaceTarget,operation:"search")
  let early = evidence.decorate(["status":"stopped","error":"permission"])
  check(early["requestedWorkspace"] as? String == scopedWorkspaceTarget && early["workspaceSwitchMayHaveBeenRequested"] as? Bool == false && early["workspaceSelection"] == nil && early["operation"] as? String == "search", "early failure reports requested scope with no selection attempt")
  evidence.begin()
  check(evidence.decorate([:])["workspaceSwitchMayHaveBeenRequested"] is NSNull, "unresolved selection call preserves unknown uncertainty")
  let attempted:[String:Any] = ["status":"stopped","switchAttempted":true,"workspaceSwitchMayHaveBeenRequested":false,"before":["diagnostic":"retained"]]
  evidence.finish(attempted)
  let failed = evidence.decorate(["status":"stopped","error":"command"])
  check(failed["workspaceSwitchMayHaveBeenRequested"] as? Bool == true, "attempted switch cannot lose stronger true uncertainty")
  check(NSDictionary(dictionary:failed["workspaceSelection"] as! [String:Any]).isEqual(to:attempted), "selection evidence remains the complete raw receipt")
  check(failed["error"] as? String == "command", "workspace annotation does not replace command failure")
  evidence.finish(["switchAttempted":false,"workspaceSwitchMayHaveBeenRequested":false])
  check(evidence.decorate([:])["workspaceSwitchMayHaveBeenRequested"] as? Bool == false, "verified no-op preserves explicit false")
  evidence.finish(["switchAttempted":false])
  check(evidence.decorate([:])["workspaceSwitchMayHaveBeenRequested"] is NSNull, "incomplete switch evidence never invents false")
  let transcript = evidence.decorate(["operation":"read-transcript","phase":"select"])
  check(transcript["phase"] as? String == "select" && transcript["operation"] as? String == "read-transcript", "decoration preserves transcript phases and explicit operation")
}
let workspaceSelectionProof:[String:Any] = ["operation":"switch-workspace","status":"ok","requested":scopedWorkspaceTarget,"before":workspaceBefore.receipt(workspaceRows),"after":workspaceAfter.receipt(workspaceAfterRows),"selection":["name":"Two","domain":"two.slack.com"],"switchAttempted":true,"workspaceSwitchMayHaveBeenRequested":true,"selector":["opened":true,"reused":false,"verificationOpened":true,"closed":true]]
do {
  var evidence = WorkspaceSelectionEvidence(requested:scopedWorkspaceTarget,operation:"save-media")
  let early=evidence.decorate(["status":"stopped","error":"permission"])
  check(early["operation"] as? String == "save-media" && early["requestedWorkspace"] as? String == scopedWorkspaceTarget && early["workspaceSelection"] == nil, "early save refusal retains requested workspace without inventing selection")
  check(early["workspaceSwitchMayHaveBeenRequested"] as? Bool == false && early["action"] == nil, "preselection save refusal cannot claim workspace or Download input")
  evidence.begin()
  check(evidence.decorate([:])["workspaceSwitchMayHaveBeenRequested"] is NSNull, "interrupted scoped save selection retains unknown switch uncertainty")
  evidence.finish(workspaceSelectionProof)
  for phase in ["select","source-select","viewer-select","started","publish","result"] {
    let attempted=["started","publish","result"].contains(phase)
    let raw:[String:Any] = ["operation":"save-media","requested":"FFILE","phase":phase,"action":["attempted":attempted,"accepted":attempted],"selection":["token":"offered"],"workspaceScope":["contextId":workspaceAfter.contextId,"windowId":workspaceAfter.windowId]]
    let receipt=evidence.decorate(raw)
    check(receipt["operation"] as? String == "save-media" && receipt["requested"] as? String == "FFILE" && receipt["phase"] as? String == phase, "workspace decoration preserves save protocol operation, attachment and phase")
    check(NSDictionary(dictionary:receipt["workspaceSelection"] as! [String:Any]).isEqual(to:workspaceSelectionProof), "every save phase preserves the complete verified workspace selection receipt")
    let stopped=workspaceScopeFailure(receipt,"workspace drift")
    check(stopped["status"] as? String == "stopped" && stopped["workspaceScope"] == nil && stopped["phase"] as? String == phase, "scope drift stops every save phase and removes its success stamp")
    check((stopped["action"] as? [String:Bool]) == ["attempted":attempted,"accepted":attempted] && (stopped["selection"] as? [String:String]) == ["token":"offered"], "scope failure preserves Download uncertainty and original capability evidence")
    check(stopped["workspaceSwitchMayHaveBeenRequested"] as? Bool == true && stopped["workspaceSelection"] != nil, "save scope failure never loses possibly effective workspace-switch evidence")
  }
}
check(try workspaceSelectionDestination(workspaceSelectionProof,requested:scopedWorkspaceTarget,initialWindow:12) == workspaceAfter, "only the exact verified post-switch workspace can authorize requested work")
var workspaceNoopProof = workspaceSelectionProof
workspaceNoopProof["requested"] = "EONE"
workspaceNoopProof["after"] = workspaceBefore.receipt(workspaceRows)
workspaceNoopProof["selection"] = ["name":"One","domain":"one.slack.com"]
workspaceNoopProof["switchAttempted"] = false
workspaceNoopProof["workspaceSwitchMayHaveBeenRequested"] = false
workspaceNoopProof["selector"] = ["opened":false,"reused":true,"verificationOpened":false,"closed":false]
check(try workspaceSelectionDestination(workspaceNoopProof,requested:"EONE",initialWindow:12) == workspaceBefore, "verified no-op retains its original workspace and selector ownership evidence")
for mutation in 0..<12 {
  var receipt = workspaceSelectionProof
  switch mutation {
  case 0: receipt["status"] = "stopped"
  case 1: receipt["operation"] = "workspaces"
  case 2: receipt["requested"] = "workspace:foreign.slack.com"
  case 3: receipt.removeValue(forKey:"after")
  case 4: receipt["after"] = WorkspaceView(url:workspaceAfter.url,name:"Two",windowId:13).receipt(workspaceAfterRows)
  case 5: receipt["selection"] = ["name":"Two","domain":"foreign.slack.com"]
  case 6: receipt["switchAttempted"] = false
  case 7: receipt["workspaceSwitchMayHaveBeenRequested"] = false
  case 8: receipt["selector"] = ["opened":true,"reused":false,"verificationOpened":false,"closed":true]
  case 9: receipt["selector"] = ["opened":false,"reused":false,"verificationOpened":true,"closed":true]
  case 10: receipt["selector"] = ["opened":true,"reused":true,"verificationOpened":true,"closed":true]
  default: receipt["selector"] = ["opened":true,"reused":false,"verificationOpened":true,"closed":false]
  }
  rejectWorkspace { _ = try workspaceSelectionDestination(receipt,requested:scopedWorkspaceTarget,initialWindow:12) }
}
let scopedFailure = workspaceScopeFailure(["status":"partial","pages":[["verified":"prefix"]],"error":"original failure","workspaceScope":["contextId":"TONE","windowId":12],"workspaceSelection":workspaceSelectionProof], "workspace drift")
check(scopedFailure["status"] as? String == "stopped" && scopedFailure["workspaceScope"] == nil, "failed final scope cannot retain a success stamp")
check(scopedFailure["error"] as? String == "original failure" && scopedFailure["workspaceScopeError"] as? String == "workspace drift", "scope failure preserves original failure separately")
check((scopedFailure["pages"] as? [[String:Any]])?.count == 1 && scopedFailure["workspaceSelection"] != nil, "stopped scope retains raw prefix and selection diagnostics")
check(workspaceScopeFailure([:],"workspace drift")["error"] as? String == "workspace drift", "scope failure supplies a stopped reason when no earlier failure exists")
do {
  let edges = [0: [1, 2], 1: [3], 2: [4, 5], 5: [6]]
  let kinds = [0: "wrapper", 1: "wrapper", 2: "wrapper", 3: "option", 4: "decoration", 5: "wrapper", 6: "option"]
  let nested = try pickerOptionLeaves([0], children: { edges[$0] ?? [] }, kind: { kinds[$0] ?? "unsupported" })
  check(nested == [3, 6], "passive layout wrappers preserve suggestion order")
  check(try pickerOptionLeaves([3, 6], children: { _ in [] }, kind: { _ in "option" }) == nested, "direct and wrapped options are equivalent")
  check(try pickerOptionLeaves([4], children: { _ in [] }, kind: { _ in "decoration" }).isEmpty, "decorations do not become navigation options")
  for mode in 0..<4 {
    var rejected = false
    do {
      _ = try pickerOptionLeaves([0], children: { value in
        if mode == 0 { return [value] }
        if mode == 1 { return [1, 1] }
        return [value + 1]
      }, kind: { value in
        if mode == 0 || mode == 2 { return "wrapper" }
        if mode == 1 { return value == 0 ? "wrapper" : "option" }
        return "unsupported"
      })
    } catch { rejected = true }
    check(rejected, "cycles, aliases, excessive wrappers and unknown controls withhold options")
  }
}
do {
  let headingClasses = ["c-search_autocomplete_section_header", "c-search_autocomplete_section_header--ia4", "c-search_autocomplete_section_header--first"]
  let passiveActions = ["AXShowMenu", "AXScrollToVisible"]
  let shapes = [
    0: PickerHeadingShape(role:"AXHeading",classes:headingClasses,actions:passiveActions,focused:false,children:[1]),
    1: PickerHeadingShape(role:"AXGroup",classes:["c-search_autocomplete__header_label_text"],actions:passiveActions,focused:false,children:[2]),
    2: PickerHeadingShape(role:"AXStaticText",classes:[],actions:passiveActions,focused:false,children:[Int]()),
  ]
  var headingReads: [Int] = []
  check(pickerWrappedHeading(0,read:{ headingReads.append($0); return shapes[$0]! }),"the observed passive heading-label wrapper is a decoration")
  check(headingReads == [0,1,2],"wrapped heading validation reads only its three bound nodes")
  let nonfirstClasses = Array(headingClasses.prefix(2))
  let nonfirstHeading = PickerHeadingShape(role:"AXHeading",classes:nonfirstClasses,actions:passiveActions,focused:false,children:[1])
  check(pickerWrappedHeading(0,read:{ $0 == 0 ? nonfirstHeading : shapes[$0]! }),"the observed nonfirst section heading retains the same passive wrapper proof")
  for classes in [[], [headingClasses[0]], [headingClasses[1]], [headingClasses[0],headingClasses[2]], nonfirstClasses + ["unknown-class"], headingClasses + ["unknown-class"]] {
    let changed = PickerHeadingShape(role:"AXHeading",classes:classes,actions:passiveActions,focused:false,children:[1])
    check(!pickerWrappedHeading(0,read:{ $0 == 0 ? changed : shapes[$0]! }),"only the two observed section-header class sets can authorize a passive wrapper")
  }
  for node in 0...2 {
    for mutation in 0..<10 {
      let original = shapes[node]!
      let changed = PickerHeadingShape(
        role: mutation == 0 ? "AXButton" : original.role,
        classes: mutation == 1 ? ["unknown-class"] : original.classes,
        actions: mutation == 2 ? ["AXPress"] : mutation == 3 ? ["AXConfirm"] : mutation == 4 ? nil : original.actions,
        focused: mutation == 5 ? true : mutation == 6 ? nil : original.focused,
        children: mutation == 7 ? nil : mutation == 8 ? [1,2] : mutation == 9 ? [0] : original.children)
      check(!pickerWrappedHeading(0,read:{ $0 == node ? changed : shapes[$0]! }),"interactive, unknown, multiple, missing and repeated heading structure cannot become a decoration")
    }
  }
}
do {
  let instant = Date(timeIntervalSince1970: 100)
  let fields: [String: Any] = [
    "role": "AXHeading", "classes": ["heading-class"], "enabled": false, "focused": true,
    "actions": ["AXPress"], "label": "private-label", "value": "private-value",
    "id": "private-id", "url": "https://private.invalid", "AXTitle": "private-title",
  ]
  var reads: [Int] = []
  let result = pickerRejectionStructure(0, now: { instant }) { item in
    reads.append(item)
    return (fields, item == 0 ? [1, 2] : [])
  }
  let nodes = result["nodes"] as! [[String: Any]]
  let encoded = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
  check(!encoded.contains("private"), "picker rejection structure never copies private labels, values, titles, IDs or URLs")
  check(reads == [0, 1, 2] && nodes.count == 3, "picker rejection diagnostic preserves bounded descendant order")
  check(nodes[0]["parent"] is NSNull && nodes[1]["parent"] as? Int == 0 && nodes[2]["depth"] as? Int == 1, "picker rejection structure retains local ownership edges")
  check(nodes[0]["role"] as? String == "AXHeading" && nodes[0]["classes"] as? [String] == ["heading-class"] && nodes[0]["actions"] as? [String] == ["AXPress"], "picker rejection retains only requested structural vocabulary")
  check(nodes[0]["enabled"] as? Bool == false && nodes[0]["focused"] as? Bool == true, "picker rejection preserves false and true state values")
  check(nodes.allSatisfy { Set($0.keys) == Set(["index", "parent", "depth", "childCount", "role", "classes", "actions", "enabled", "focused"]) }, "picker rejection has an explicit structural-only field allowlist")
  check(result["structuralFieldsOnly"] as? Bool == true && result["truncated"] as? Bool == false && result["limits"] as? [String] == [], "complete picker diagnostics distinguish redaction from truncation")
  let deep = pickerRejectionStructure(0, now: { instant }) { item in (fields, [item + 1]) }
  check((deep["nodes"] as? [[String: Any]])?.count == 4 && deep["limits"] as? [String] == ["depth-limit"], "picker diagnostics stop at depth three")
  var wideReads = 0
  let wide = pickerRejectionStructure(0, now: { instant }) { item in
    wideReads += 1
    return (fields, item == 0 ? Array(1...100) : [])
  }
  check(wideReads == 12 && (wide["nodes"] as? [[String: Any]])?.count == 12 && wide["limits"] as? [String] == ["node-limit"], "picker diagnostics read at most twelve nodes")
  let repeated = pickerRejectionStructure(0, now: { instant }) { _ in (fields, [0]) }
  check((repeated["nodes"] as? [[String: Any]])?.count == 1 && repeated["limits"] as? [String] == ["repeated-node"], "picker diagnostics stop repeated identities without recursion")
  let unavailable = pickerRejectionStructure(0, now: { instant }) { _ in ([String: Any](), Optional<[Int]>.none) }
  let unknownNode = (unavailable["nodes"] as! [[String: Any]])[0]
  check(["childCount", "role", "classes", "actions", "enabled", "focused"].allSatisfy { unknownNode[$0] is NSNull }, "unavailable picker state remains unknown rather than false or empty")
  check(unavailable["limits"] as? [String] == ["children-unavailable"] && unavailable["truncated"] as? Bool == true, "missing picker child inventory cannot claim complete capture")
  var clockCalls = 0
  var timedReads = 0
  let timed = pickerRejectionStructure(0, now: {
    clockCalls += 1
    return instant.addingTimeInterval(clockCalls <= 2 ? 0 : 2)
  }) { item in
    timedReads += 1
    return (fields, [item + 1])
  }
  check(timedReads == 1 && timed["limits"] as? [String] == ["time-limit"], "picker diagnostic stops new reads after its one-second budget")
  let longValue = String(repeating: "x", count: 201)
  let long = pickerRejectionStructure(0, now: { instant }) { _ in
    (["role": longValue, "classes": Array(repeating: longValue, count: 17), "actions": Array(repeating: longValue, count: 17)], [Int]())
  }
  let longNode = (long["nodes"] as! [[String: Any]])[0]
  check((longNode["role"] as? String)?.count == 200 && long["limits"] as? [String] == ["field-limit"], "overlong picker fields are bounded with truncation evidence")
  check(["classes", "actions"].allSatisfy { key in
    let values = longNode[key] as! [String]
    return values.count == 16 && values.allSatisfy { $0.count == 200 }
  }, "picker action and class lists have independent count and string bounds")
  check(pickerFailureReceipt(["status": "ok"], result)["pickerStructure"] == nil, "successful receipts omit stale picker rejection diagnostics")
  check(pickerFailureReceipt(["error": "original refusal"], nil)["pickerStructure"] == nil, "errors without picker evidence invent no diagnostic")
  let receipt = pickerFailureReceipt(["error": "original refusal", "status": "stopped"], result)
  check(receipt["error"] as? String == "original refusal" && (receipt["pickerStructure"] as? [String: Any])?["returnedCount"] as? Int == 3, "failed receipts retain their original refusal and captured picker structure")
}
for (input, expected) in [
  ("in:#general after:2026-11-08", "in:general after:2026-11-08"),
  ("Search for: in:#team-updates", "Search for: in:team-updates"),
  ("in:#a  in:#b\ttext", "in:a  in:b\ttext"),
  ("\"in:#general\"", "\"in:#general\""),
  ("'in:#general'", "'in:#general'"),
  ("\"text in:#general\" in:#other", "\"text in:#general\" in:other"),
  ("in:#general,", "in:#general,"),
  ("-in:#general", "-in:#general"),
  ("from:#general", "from:#general"),
  ("in:##general", "in:##general"),
  ("in:#general, in channel", "in:#general, in channel"),
  ("in:#general \u{2014} Search", "in:general \u{2014} Search"),
  ("\\in:#general", "\\in:#general"),
  ("\"unfinished in:#general", "\"unfinished in:#general")
] {
  check(canonicalChannelSearch(input) == expected, "channel-filter normalization preserves literals and distinct filters")
}
do {
  let rows:[[String:Any]] = [
    ["index":0,"parent":NSNull(),"role":"AXGroup","id":"modal","classes":["ReactModal__Content"],"label":"Recent downloads","AXTitle":"Recent downloads","AXValue":"private-value","url":"https://secret.invalid","AXHelp":"private-help"],
    ["index":1,"parent":0,"role":"AXTextArea","id":"input","classes":[],"label":"Close","AXTitle":"Close","AXValue":"private-draft"],
    ["index":2,"parent":0,"role":"AXMenuItem","id":"item","classes":[],"label":"Download","AXTitle":"Download","AXValue":"private-menu"],
    ["index":3,"parent":0,"role":"AXStaticText","id":"","classes":[],"label":"Download","AXValue":"Download"],
    ["index":4,"parent":0,"role":"AXGroup","id":"unknown","classes":[],"label":"private-title","AXTitle":"private-title"]
  ]
  let capture:[String:Any] = ["nodes":rows,"truncated":false]
  let original=try JSONSerialization.data(withJSONObject:capture,options:[.sortedKeys])
  let result=viewerIsolationStructure(capture)
  let retained=result["nodes"] as! [[String:Any]]
  let encoded=String(decoding:try JSONSerialization.data(withJSONObject:result),as:UTF8.self)
  check(!encoded.contains("private-") && !encoded.contains("secret.invalid"),"viewer rejection diagnostics omit values, URLs, help and unknown text")
  check(retained[0]["label"] as? String == "Recent downloads" && retained[3]["label"] as? String == "Download","known fixed toast and tooltip labels remain useful")
  check(retained[4]["label"] == nil && retained[4]["AXTitle"] == nil,"unknown modal title is never copied")
  check(retained[1]["label"] == nil && retained[1]["AXTitle"] == nil && retained[2]["label"] == nil && retained[2]["AXTitle"] == nil,"text inputs and menu rows never expose their text even if it resembles a known label")
  check(retained[0]["parent"] is NSNull && retained[3]["parent"] as? Int == 0 && retained[3]["index"] as? Int == 3,"diagnostic node indices and parent evidence survive redaction")
  check(retained.allSatisfy { Set($0.keys).isSubset(of:["index","parent","role","id","classes","label","AXTitle"]) },"structural diagnostics contain only the explicit field allowlist")
  check(try JSONSerialization.data(withJSONObject:capture,options:[.sortedKeys]) == original,"diagnostic construction never mutates the source capture")
  check(result["captureTruncated"] as? Bool == false && result["nodesTruncated"] as? Bool == false && result["structuralFieldsOnly"] as? Bool == true,"complete bounded captures remain distinct from text-redacted structural output")
  check(viewerIsolationStructure(["nodes":rows,"truncated":true])["captureTruncated"] as? Bool == true,"prior capture truncation is retained")
  check(viewerIsolationStructure(["nodes":rows])["captureTruncated"] is NSNull,"missing capture completeness remains unknown")
  let bounded=viewerIsolationStructure(["nodes":Array(repeating:rows[0],count:65),"truncated":false])
  check((bounded["nodes"] as? [[String:Any]])?.count == 64 && bounded["capturedCount"] as? Int == 65 && bounded["nodesTruncated"] as? Bool == true,"rejected modal diagnostics stop at64 nodes and retain the omitted-count evidence")
  check(viewerIsolationStructure([:])["returnedCount"] as? Int == 0,"absent rows invent no structural evidence")
  let long=viewerIsolationStructure(["nodes":[["index":0,"parent":NSNull(),"role":String(repeating:"r",count:201),"id":String(repeating:"i",count:201),"classes":Array(repeating:String(repeating:"c",count:201),count:33)]],"truncated":false])
  let first=(long["nodes"] as! [[String:Any]])[0]
  check(long["fieldValuesTruncated"] as? Bool == true,"overlong structural fields have explicit truncation evidence")
  check((first["role"] as? String)?.count == 200 && (first["id"] as? String)?.count == 200 && (first["classes"] as? [String])?.count == 32,"structural fields and class inventories are bounded")
  check((first["classes"] as! [String]).allSatisfy { $0.count == 200 },"each retained class value is independently bounded")
  let failure=ViewerIsolationFailure(description:"Another modal appeared; viewer input withheld",diagnostic:result)
  check(String(describing:failure) == "Another modal appeared; viewer input withheld" && failure.diagnostic["structuralFieldsOnly"] as? Bool == true,"typed diagnostics preserve the original concise refusal text")
}
do {
  var images:[[String:Any]] = [
    ["index":6,"parent":5,"role":"AXImage","classes":["p-image_viewer__image","private-class"],"url":viewerURL,"label":"private-filename","AXValue":"private-value"],
    ["index":7,"parent":5,"role":"AXImage","classes":["p-image_viewer__image"],"url":"https://files.slack.com/files-pri/TDEMO-FFILE/another-private-name.png"],
    ["index":8,"parent":5,"role":"AXImage","classes":["p-image_viewer__image"],"url":"https://files.slack.com/files-pri/TDEMO-FOTHER/demo.png"],
    ["index":9,"parent":5,"role":"AXImage","classes":["p-image_viewer__image"],"url":"https://files.slack.com/files-pri/TOTHER-FFILE/demo.png"],
    ["index":10,"parent":5,"role":"AXGroup","classes":["p-image_viewer__image"]],
    ["role":"private-role","classes":["p-image_viewer__image"],"url":"https://private.invalid/secret"]
  ]
  images.append(images[0])
  let content:[String:Any] = ["nodes":images,"truncated":false]
  let original=try JSONSerialization.data(withJSONObject:content,options:[.sortedKeys])
  let result=viewerFailureDiagnostic(content:content,sourceURL:viewerURL,contextId:"TDEMO",phase:"opening",reason:"image-source-mismatch",capturedAt:1794753769000)
  let retained=result["images"] as! [[String:Any]]
  let encoded=String(decoding:try JSONSerialization.data(withJSONObject:result),as:UTF8.self)
  for privateValue in ["private-","private.invalid","files.slack.com","demo.png","TDEMO","FFILE","FOTHER","TOTHER"] {
    check(!encoded.contains(privateValue),"rejection diagnostics never copy private URL, file, owner, label, value, role or class strings")
  }
  check(result["activeImageCount"] as? Int == 7 && retained.count == 6 && result["omittedImages"] as? Int == 1,"rejection image inventory is capped without hiding its true count")
  check(result["capturedAt"] as? Int64 == 1794753769000 && result["phase"] as? String == "opening" && result["reason"] as? String == "image-source-mismatch","rejection evidence keeps the original capture time and comparison phase")
  check(result["captureComplete"] as? Bool == true && result["sourceVerifiedAtCaptureStart"] as? Bool == true && result["windowVerifiedAtCaptureStart"] as? Bool == true,"diagnostic evidence describes the guarded rejecting capture")
  check(retained[0]["urlMatchesSource"] as? Bool == true && retained[0]["fileMatchesSource"] as? Bool == true && retained[0]["ownerMatchesSource"] as? Bool == true,"exact source match remains distinct from same-file rendition evidence")
  check(retained[1]["urlMatchesSource"] as? Bool == false && retained[1]["fileMatchesSource"] as? Bool == true && retained[1]["ownerMatchesSource"] as? Bool == true,"same file and owner never imply byte-exact source URL")
  check(retained[2]["fileMatchesSource"] as? Bool == false && retained[2]["ownerMatchesSource"] as? Bool == true,"another file remains an explicit mismatch even within the same owner")
  check(retained[3]["fileMatchesSource"] as? Bool == true && retained[3]["ownerMatchesSource"] as? Bool == false,"same file-shaped identifier never hides another owner")
  check(retained[4]["urlPresent"] as? Bool == false && retained[4]["urlMatchesSource"] is NSNull && retained[4]["fileMatchesSource"] is NSNull && retained[4]["ownerMatchesSource"] is NSNull,"absent image URL is unknown rather than a proven mismatch")
  check(retained[5]["urlPresent"] as? Bool == true && retained[5]["urlMatchesSource"] as? Bool == false && retained[5]["fileMatchesSource"] is NSNull && retained[5]["ownerMatchesSource"] is NSNull,"unparseable URL keeps exact mismatch separate from unknown file ownership")
  check(retained[5]["index"] is NSNull && retained[5]["parent"] is NSNull && retained[5]["role"] is NSNull,"missing indexes and unrecognized roles cannot become invented structural evidence")
  check(retained.allSatisfy {($0["classes"] as? [String]) == ["p-image_viewer__image"] && Set($0.keys) == Set(["index","parent","role","classes","urlPresent","urlMatchesSource","fileMatchesSource","ownerMatchesSource"])},"only the fixed image class and explicit comparison fields survive redaction")
  check(try JSONSerialization.data(withJSONObject:content,options:[.sortedKeys]) == original,"rejection diagnostics never mutate evidence used for source verification")
  let empty=viewerFailureDiagnostic(content:[:],sourceURL:viewerURL,contextId:"TDEMO",phase:"opening",reason:"missing-image",capturedAt:1)
  check(empty["activeImageCount"] as? Int == 0 && (empty["images"] as? [[String:Any]])?.isEmpty == true && empty["captureComplete"] as? Bool == false,"absent capture never claims a complete image inventory")
  let truncated=viewerFailureDiagnostic(content:["nodes":images,"truncated":true],sourceURL:viewerURL,contextId:"TDEMO",phase:"opening",reason:"capture-incomplete",capturedAt:2)
  check(truncated["captureComplete"] as? Bool == false,"a bounded rejection preserves incomplete-capture evidence")
  let failure=ViewerVerificationFailure(description:"Opened viewer image does not match the retained source URL",diagnostic:result)
  check(String(describing:failure) == "Opened viewer image does not match the retained source URL" && failure.diagnostic["capturedAt"] as? Int64 == 1794753769000,"typed image rejection preserves its original error and rejection-time evidence")
  let cleanup=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {_ in
    throw ViewerVerificationFailure(description:"Later cleanup capture incomplete",diagnostic:truncated)
  }
  let cleanupEvidence=cleanup["failure"] as? [String:Any]
  check(cleanup["status"] as? String == "withheld" && cleanupEvidence?["capturedAt"] as? Int64 == 2,"cleanup retains its own later rejection evidence without performing Close")
  check(failure.diagnostic["capturedAt"] as? Int64 == 1794753769000 && failure.diagnostic["reason"] as? String == "image-source-mismatch","later cleanup evidence does not replace the original rejection diagnostic")
}
for kind in ["file","audio","video"] {
  var rows=kind == "file" ? detailsPaneFixture() : kind == "audio" ? detailsPaneFixture(true) : videoDetailsPane
  for index in rows.indices {
    rows[index]["classes"]=(rows[index]["classes"] as? [String] ?? [])+["private-diagnostic-class"]
    rows[index]["AXValue"]="private-value";rows[index]["AXHelp"]="private-help"
  }
  rows[7]["label"]="Download private-filename"
  let sourcePage=kind == "file" ? detailsPage : nil
  let downloadURL=rows[7]["url"] as! String
  let content:[String:Any]=["nodes":rows,"truncated":false]
  let original=try JSONSerialization.data(withJSONObject:content,options:[.sortedKeys])
  let evidence=fileDetailsFailureDiagnostic(content:content,fileId:"FFILE",sourceFilePageURL:sourcePage,expectedDownloadURL:downloadURL,contextId:"TDEMO",mediaKind:kind,phase:"capture",reason:"source-or-layout-unverified",capturedAt:1794753769000)
  let cards=evidence["cards"] as! [[String:Any]],identities=evidence["identities"] as! [[String:Any]],downloads=evidence["downloadControls"] as! [[String:Any]]
  let encoded=String(decoding:try JSONSerialization.data(withJSONObject:evidence),as:UTF8.self)
  for secret in ["private-","slack.com","demo.pdf","FFILE","TDEMO","UDEMO"] {check(!encoded.contains(secret),"file/audio/video failure evidence never copies private classes, values, labels, IDs or URLs")}
  check(evidence["family"] as? String == "file-details" && evidence["mediaKind"] as? String == kind && evidence["capturedAt"] as? Int64 == 1794753769000,"details rejection retains family, kind and original capture time")
  check(evidence["cardCount"] as? Int == 1 && evidence["identityCount"] as? Int == 1 && evidence["downloadControlCount"] as? Int == 1,"details diagnostics inventory observed cards, identities and Download controls independently")
  check(cards[0]["fileMatchesSource"] as? Bool == true && identities[0]["fileMatchesSource"] as? Bool == true,"each supported media kind exposes its exact file binding as comparison evidence only")
  check(downloads[0]["urlPresent"] as? Bool == true && downloads[0]["urlAllowed"] as? Bool == true && downloads[0]["fileMatchesSource"] as? Bool == true && downloads[0]["urlMatchesExpected"] as? Bool == true,"observed Download comparison preserves exact URL, allowed-route and file evidence")
  if kind == "file" {check(identities[0]["pageMatchesSource"] as? Bool == true,"document page comparison retains byte-exact equality")}
  else {check(identities[0]["pageURLPresent"] as? Bool == false && identities[0]["pageMatchesSource"] is NSNull,"audio/video description identity does not invent an observed file page")}
  check(try JSONSerialization.data(withJSONObject:content,options:[.sortedKeys]) == original,"details diagnostics never modify original source-verification evidence")
  var missing=rows
  if kind == "file" {missing[5].removeValue(forKey:"url")}
  else {missing[5]["id"]=(kind == "audio" ? "transcript-description-" : "caption-description-")+"private-invalid"}
  missing[7].removeValue(forKey:"url")
  let unknown=fileDetailsFailureDiagnostic(content:["nodes":missing,"truncated":true],fileId:"FFILE",sourceFilePageURL:sourcePage,expectedDownloadURL:downloadURL,contextId:"TDEMO",mediaKind:kind,phase:"cleanup",reason:"incomplete-capture",capturedAt:1794753769001)
  let unknownIdentity=(unknown["identities"] as! [[String:Any]])[0],unknownDownload=(unknown["downloadControls"] as! [[String:Any]])[0]
  check(unknown["captureComplete"] as? Bool == false && unknownIdentity["fileMatchesSource"] is NSNull && unknownIdentity["pageMatchesSource"] is NSNull,"incomplete or unparseable file identity remains unknown rather than mismatched")
  check(unknownDownload["urlPresent"] as? Bool == false && unknownDownload["urlAllowed"] is NSNull && unknownDownload["urlMatchesExpected"] is NSNull && unknownDownload["fileMatchesSource"] is NSNull,"missing Download URL keeps absence separate from disallowed or mismatched evidence")
  var foreign=rows
  if kind == "file" {foreign[5]["url"]=detailsPage.replacingOccurrences(of:"FFILE",with:"FOTHER")}
  else {foreign[5]["id"]=(kind == "audio" ? "transcript-description-" : "caption-description-")+"FOTHER"}
  foreign[7]["url"]=downloadURL.replacingOccurrences(of:"FFILE",with:"FOTHER")
  let mismatch=fileDetailsFailureDiagnostic(content:["nodes":foreign,"truncated":false],fileId:"FFILE",sourceFilePageURL:sourcePage,expectedDownloadURL:downloadURL,contextId:"TDEMO",mediaKind:kind,phase:"capture",reason:"source-or-layout-unverified",capturedAt:3)
  check((mismatch["identities"] as! [[String:Any]])[0]["fileMatchesSource"] as? Bool == false && (mismatch["downloadControls"] as! [[String:Any]])[0]["urlMatchesExpected"] as? Bool == false,"explicit foreign identity and Download mismatch remain false, not unknown")
  var disallowed=rows;disallowed[7]["url"]="https://private.invalid/not-a-slack-download"
  let denied=fileDetailsFailureDiagnostic(content:["nodes":disallowed,"truncated":false],fileId:"FFILE",sourceFilePageURL:sourcePage,expectedDownloadURL:downloadURL,contextId:"TDEMO",mediaKind:kind,phase:"capture",reason:"source-or-layout-unverified",capturedAt:3)
  let deniedDownload=(denied["downloadControls"] as! [[String:Any]])[0]
  check(deniedDownload["urlAllowed"] as? Bool == false && deniedDownload["urlMatchesExpected"] as? Bool == false && deniedDownload["fileMatchesSource"] is NSNull,"a disallowed URL remains explicitly false while unparseable file identity stays unknown")
  var boundedRows:[[String:Any]]=[]
  for copy in 0..<7 {
    for row in rows {
      var shifted=row;shifted["index"]=(row["index"] as! Int)+copy*100
      if let parent=row["parent"] as? Int {shifted["parent"]=parent+copy*100}
      boundedRows.append(shifted)
    }
  }
  let bounded=fileDetailsFailureDiagnostic(content:["nodes":boundedRows,"truncated":false],fileId:"FFILE",sourceFilePageURL:sourcePage,expectedDownloadURL:nil,contextId:"TDEMO",mediaKind:kind,phase:"opening",reason:"ambiguous-layout",capturedAt:4)
  for (key,countKey,omittedKey) in [("cards","cardCount","omittedCards"),("identities","identityCount","omittedIdentities"),("downloadControls","downloadControlCount","omittedDownloadControls")] {
    check((bounded[key] as! [[String:Any]]).count == 6 && bounded[countKey] as? Int == 7 && bounded[omittedKey] as? Int == 1,"each details diagnostic inventory is bounded independently while retaining omitted counts")
  }
  check((bounded["downloadControls"] as! [[String:Any]]).allSatisfy {$0["urlMatchesExpected"] is NSNull},"opening diagnostics never invent an expected Download URL before selection")
  let originalFailure=ViewerVerificationFailure(description:"original details rejection",diagnostic:evidence)
  let cleanup=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {_ in throw ViewerVerificationFailure(description:"cleanup details rejection",diagnostic:unknown)}
  check((cleanup["failure"] as? [String:Any])?["capturedAt"] as? Int64 == 1794753769001 && originalFailure.diagnostic["capturedAt"] as? Int64 == 1794753769000,"later details cleanup diagnostics remain separate from the initial rejection")
}
let missingDetailsDiagnostic=fileDetailsFailureDiagnostic(content:[:],fileId:"FFILE",sourceFilePageURL:nil,expectedDownloadURL:nil,contextId:nil,mediaKind:"private-kind",phase:"opening",reason:"missing-pane",capturedAt:0)
check(missingDetailsDiagnostic["mediaKind"] as? String == "unknown" && missingDetailsDiagnostic["captureComplete"] as? Bool == false && missingDetailsDiagnostic["cardCount"] as? Int == 0 && missingDetailsDiagnostic["identityCount"] as? Int == 0 && missingDetailsDiagnostic["downloadControlCount"] as? Int == 0,"absent details capture reports unknown kind and zero observed evidence without completeness")
do {
  var rejectedRows=detailsSourceFixture();rejectedRows[0]["label"]="private changed source"
  let rejected=fileDetailsFailureDiagnostic(content:["nodes":rejectedRows,"truncated":false],fileId:"FFILE",sourceFilePageURL:detailsPage,contextId:"TDEMO",mediaKind:"file",phase:"source-verification",reason:"source-signature-mismatch",capturedAt:100,sourceVerifiedAtCaptureStart:false,sourceSignatureMatched:false)
  let original=ViewerVerificationFailure(description:"File details message/media identity or order changed",diagnostic:rejected)
  check(original.diagnostic["sourceVerifiedAtCaptureStart"] as? Bool == false && original.diagnostic["sourceSignatureMatched"] as? Bool == false && original.diagnostic["phase"] as? String == "source-verification" && original.diagnostic["reason"] as? String == "source-signature-mismatch" && original.diagnostic["capturedAt"] as? Int64 == 100,"a rejected source signature cannot claim source verification succeeded")
  let later=fileDetailsFailureDiagnostic(content:["nodes":detailsPaneFixture(),"truncated":true],fileId:"FFILE",sourceFilePageURL:detailsPage,contextId:"TDEMO",mediaKind:"file",phase:"cleanup",reason:"incomplete-capture",capturedAt:200)
  check(later["sourceVerifiedAtCaptureStart"] as? Bool == true && later["sourceSignatureMatched"] == nil,"ordinary guarded pane diagnostics preserve their existing verified-source default without inventing a signature comparison")
  let cleanup=cleanupOwnedViewerAfterFailure(downloadAttempted:false,openerAccepted:true,closeAttempted:false,viewerClosed:false) {_ in throw ViewerVerificationFailure(description:"Later pane incomplete",diagnostic:later)}
  let failure=cleanup["failure"] as? [String:Any]
  check(cleanup["closeAttempted"] as? Bool == false && failure?["capturedAt"] as? Int64 == 200 && failure?["sourceVerifiedAtCaptureStart"] as? Bool == true && original.diagnostic["capturedAt"] as? Int64 == 100 && original.diagnostic["sourceVerifiedAtCaptureStart"] as? Bool == false,"later cleanup evidence never overwrites the original failed source proof or its timestamp")
}
// Composition guards: readback, identity and comparison rules.
check(composerText("hello\n") == "hello" && composerText(nil) == nil,"composer text drops only Quill's trailing newline")
check(composerReadbackMatches("hi there \n","hi there :wave:") && composerReadbackMatches("hi there :wave:\n","hi there :wave:"),"a known shortcode may become an inline emoji that AXValue omits")
check(!composerReadbackMatches("hi there!\n","hi there") && !composerReadbackMatches("hi\n","hi there :wave:") && !composerReadbackMatches(nil,"hi"),"every non-shortcode character must read back exactly")
check(composeComparable("a *bold*  _move_\n:tada: ~x~") == "a bold move x","comparison ignores markdown markers, shortcodes and whitespace layout")
check(rowComparable("hello (edited)").text == "hello" && rowComparable("hello (edited)").edited && !rowComparable("hello").edited,"the edited marker is separated from message text")
check(sameMessageText("note (edited) (edited)","note (edited)") && sameMessageText("note","note (edited)") && !sameMessageText("note","other") && !sameMessageText("",""),"delete confirmation text matches modulo one edited marker and never on empty text")
check(composerDescriptionMatches("Message to general",name:"general",thread:false) && !composerDescriptionMatches("Message to general-2",name:"general",thread:false) && !composerDescriptionMatches("Message to general",name:nil,thread:false),"main composer label must name the exact verified destination")
check(composerDescriptionMatches("Reply to thread in general",name:nil,thread:true) && !composerDescriptionMatches("Reply to thread in ",name:nil,thread:true) && !composerDescriptionMatches("Message to general",name:"general",thread:true),"thread composer label uses the observed reply shape")
check(threadBroadcastIdentifier("C1","1700000000.000001") == "p-thread_footer__broadcast_checkbox--C1-1700000000.000001--Thread","thread composer binding uses the exact conversation and root")
check(validComposeText("line one\nline two") && !validComposeText("  \n ") && !validComposeText("bell\u{07}") && !validComposeText(String(repeating:"a",count:4001)),"message text is non-empty, bounded and free of controls other than newlines")
// Activation fallback: Return is posted only to the exact focused navigation control.
do {
  let clean = FocusReturnEvidence(targetFocused: true, otherFocusedEditable: false, queryOpen: false, windowMatches: true, alreadyOpened: false, inputHeld: false)
  func with(_ change: (inout [Bool]) -> Void) -> FocusReturnEvidence {
    var v = [clean.targetFocused, clean.otherFocusedEditable, clean.queryOpen, clean.windowMatches, clean.alreadyOpened, clean.inputHeld]
    change(&v)
    return FocusReturnEvidence(targetFocused: v[0], otherFocusedEditable: v[1], queryOpen: v[2], windowMatches: v[3], alreadyOpened: v[4], inputHeld: v[5])
  }
  check(focusReturnBlocker(clean) == nil, "a focused target in the same window with no editor or picker may receive one Return")
  check(focusReturnBlocker(with { $0[4] = true; $0[0] = false; $0[1] = true }) == nil, "a late AXPress result needs no Return and is never followed by one")
  check(focusReturnBlocker(with { $0[1] = true })?.contains("composer") == true && focusReturnBlocker(with { $0[1] = true; $0[0] = false })?.contains("composer") == true, "a focused composer or text field always withholds Return so no draft is sent")
  check(focusReturnBlocker(with { $0[0] = false }) == "Control did not take focus; Return withheld", "an unfocused target withholds Return")
  check(focusReturnBlocker(with { $0[2] = true })?.contains("Search picker") == true && focusReturnBlocker(with { $0[3] = false })?.contains("window changed") == true && focusReturnBlocker(with { $0[5] = true }) == "Physical input held; input withheld", "an open picker, changed window or held physical input withholds Return")
  check(editableFocus("AXTextArea", ["ql-editor", "ql-blank"]) && editableFocus("AXComboBox", []) && editableFocus("AXTextField", []) && editableFocus("AXGroup", ["ql-editor"]), "composers, query boxes and text fields count as editable focus")
  check(!editableFocus("AXButton", ["c-button-unstyled", "p-top_nav__search"]) && !editableFocus("AXRow", ["p-channel_sidebar__static_list__item"]) && !editableFocus("AXRadioButton", ["p-tab_rail__button"]), "the Search button, sidebar rows and tab buttons are activation targets, not editors")
  check(ActivationMethod.press.rawValue == "AXPress" && ActivationMethod.focusReturn.rawValue == "focus+Return", "activation receipts name the method used")
}
try checkDMQueryClipboard()
print("Passed \(count) native Slack guard checks")
`;

(process.platform === 'darwin' ? test : test.skip)(
  'native Slack guards validate identity, query state and isolated clipboard preservation without Slack access',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'slack-native-test-'));
    try {
      const source = await captureNativeBundle(SLACK_NATIVE_BUNDLE);
      // Compile actual declarations, replacing only the CLI entrypoint with pure
      // assertions and UUID-named pasteboard checks. No AX reads/actions,
      // NSWorkspace calls or general clipboard access are executed.
      const guards = nativeGuardBundle(source, assertions, path.join(directory, 'modules'));
      const inputs = await writeNativeSnapshot(guards, directory);
      const binary = path.join(directory, 'checks');
      await run(nativeCompileCommand(guards, inputs, binary), guards.recipe.compileTimeout);
      expect(await run([binary], 10000)).toBe('Passed 6288 native Slack guard checks\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  150000
);
