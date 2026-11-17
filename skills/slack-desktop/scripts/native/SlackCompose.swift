import AppKit
import ApplicationServices

// Guarded message composition: send to a verified conversation or thread, and
// edit or delete one of the user's own messages. Text enters through the
// verified editor's AXValue; actions use the exact Send now, Save, menu and
// dialog controls Slack exposes. No key is typed into a composer, no draft is
// overwritten and no action is ever repeated automatically.

let composeMaxCharacters = 4000

struct ComposeFailure: Error, CustomStringConvertible {
  let description: String
  // True once the irreversible action (Send now, Save or Delete) was pressed.
  let actionMayHaveOccurred: Bool
}

// Composition flags are peeled off before generic validation. Only send, edit
// and delete accept --text or --confirm-delete, and only send accepts
// --allow-clipboard; its destination rule is checked with the other clipboard
// rules once the positional arguments are known.
struct ComposeArguments: Equatable {
  let arguments: [String]
  let text: String?
  let confirmDelete: Bool
  let allowClipboard: Bool
}
func composeArguments(_ input: [String]) throws -> ComposeArguments {
  guard let operation = input.first, ["send", "edit", "delete"].contains(operation) else {
    return ComposeArguments(
      arguments: input, text: nil, confirmDelete: false, allowClipboard: false)
  }
  var remaining: [String] = []
  var text: String?
  var confirmDelete = false
  var allowClipboard = false
  for argument in input {
    if argument.hasPrefix("--text=") {
      try require(text == nil, "Specify --text once")
      text = String(argument.dropFirst("--text=".count))
    } else if argument == "--confirm-delete" {
      try require(!confirmDelete, "Specify --confirm-delete once")
      confirmDelete = true
    } else if argument == "--allow-clipboard" {
      try require(
        operation == "send", "Only send accepts --allow-clipboard; edit and delete do not")
      try require(!allowClipboard, "Specify --allow-clipboard only once")
      allowClipboard = true
    } else {
      remaining.append(argument)
    }
  }
  try require(
    (operation == "delete") == (text == nil),
    "send and edit require --text=TEXT; delete accepts no text")
  try require(
    (operation == "delete") == confirmDelete,
    "delete requires --confirm-delete; only delete accepts it")
  return ComposeArguments(
    arguments: remaining, text: text, confirmDelete: confirmDelete, allowClipboard: allowClipboard)
}

// Text as Slack's editor reports it: Quill keeps a trailing newline.
func composerText(_ value: String?) -> String? {
  guard var value else { return nil }
  if value.hasSuffix("\n") { value.removeLast() }
  return value
}

// Comparable message text: Slack renders shortcodes as images, markdown as
// formatting, smart quotes as curly quotes and wraps lines into sections, so
// compare the plain words.
func composeComparable(_ value: String) -> String {
  var text = foldTypography(value).replacingOccurrences(
    of: #":[a-z0-9_+\-']+:"#, with: " ", options: [.regularExpression, .caseInsensitive])
  text = text.replacingOccurrences(of: #"[*_~`]"#, with: "", options: .regularExpression)
  return text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
    .joined(separator: " ")
}

// Slack's editor turns a known :shortcode: into an inline emoji element that
// AXValue omits, and its smart quotes turn ' and " into ‘’ and “” as the text
// lands. Every other character must read back exactly.
func composerReadbackMatches(_ observed: String?, _ text: String) -> Bool {
  guard let observed = composerText(observed).map(foldTypography) else { return false }
  let typed = foldTypography(text)
  if observed == typed { return true }
  return observed
    == typed.replacingOccurrences(
      of: #":[a-z0-9_+\-']+:"#, with: "", options: [.regularExpression, .caseInsensitive])
}

// Slack appends an "(edited)" marker inside the edited message's rich text.
func rowComparable(_ rowText: String) -> (text: String, edited: Bool) {
  let text = composeComparable(rowText)
  if text == "(edited)" { return ("", true) }
  if text.hasSuffix(" (edited)") { return (String(text.dropLast(" (edited)".count)), true) }
  return (text, false)
}

// The delete confirmation may omit the "(edited)" marker that the row shows, and
// the author may have typed that word themselves. Equal modulo one marker.
func sameMessageText(_ first: String, _ second: String) -> Bool {
  func variants(_ value: String) -> Set<String> {
    let plain = composeComparable(value)
    return [plain, rowComparable(value).text]
  }
  return !variants(first).isDisjoint(with: variants(second)) && !composeComparable(first).isEmpty
}

func validComposeText(_ value: String) -> Bool {
  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    && value.count <= composeMaxCharacters
    && !value.unicodeScalars.contains {
      $0 != "\n" && (CharacterSet.controlCharacters.contains($0) || $0.value == 0x7F)
    }
}

// The main composer says "Message to NAME"; a thread composer says
// "Reply to thread in NAME". Accept only these observed shapes.
func composerDescriptionMatches(_ description: String, name: String?, thread: Bool) -> Bool {
  if thread { return description.hasPrefix("Reply to thread in ") && description.count > 19 }
  guard let name, !name.isEmpty else { return false }
  return description == "Message to \(name)"
}

func threadBroadcastIdentifier(_ conversationId: String, _ rootTS: String) -> String {
  "p-thread_footer__broadcast_checkbox--\(conversationId)-\(rootTS)--Thread"
}

struct ComposerSurface {
  let editor: AXUIElement
  let send: AXUIElement
  let description: String
}

func isInlineMessageEditor(_ element: AXUIElement) -> Bool {
  ancestor(element, matching: { classes($0).contains("c-message__editor__input_container") })
    != nil
}

// One composer for the verified destination: the main conversation composer, or
// the open thread pane's composer bound to its exact conversation and root.
func messageComposer(_ root: AXUIElement, _ target: [String: Any]) throws -> ComposerSurface {
  let thread = target["kind"] as? String == "thread"
  let nodes = try tree(root)
  var editors = nodes.map { $0.element }.filter {
    role($0) == "AXTextArea" && classes($0).contains("ql-editor") && !isInlineMessageEditor($0)
  }
  let threadPane = thread ? try threadView(root)?.pane : nil
  if thread {
    guard let threadPane else {
      throw Failure(description: "Thread pane is not open; nothing was typed")
    }
    editors = editors.filter { editor in
      ancestor(editor, matching: { CFEqual($0, threadPane) }) != nil
    }
  } else {
    editors = editors.filter { editor in
      ancestor(editor, matching: { classes($0).contains("p-threads_flexpane") }) == nil
        && ancestor(
          editor,
          matching: {
            classes($0).contains(where: {
              $0.hasPrefix("p-message_input") || $0 == "p-workspace__input"
            })
          }) != nil
    }
  }
  try require(
    editors.count == 1, "Expected one composer for the verified destination; nothing was typed")
  let editor = editors[0]
  let description = liveAttr(editor, kAXDescriptionAttribute) as? String ?? ""
  try require(
    composerDescriptionMatches(description, name: target["name"] as? String, thread: thread),
    "Composer label does not match the verified destination; nothing was typed")
  guard
    let container = ancestor(editor, matching: { classes($0).contains("c-wysiwyg_container") })
  else { throw Failure(description: "Composer container is not exposed; nothing was typed") }
  let sends = try tree(container).map { $0.element }.filter {
    role($0) == "AXButton" && label($0) == "Send now"
      && classes($0).contains("c-wysiwyg_container__button")
  }
  try require(sends.count == 1, "Composer has no unique Send now button; nothing was typed")
  if thread {
    guard let conversation = target["conversationId"] as? String,
      let rootTS = target["rootTS"] as? String, let threadPane
    else { throw Failure(description: "Thread identity unavailable; nothing was typed") }
    let expected = threadBroadcastIdentifier(conversation, rootTS)
    let boxes = try tree(threadPane).map { $0.element }.filter {
      string($0, "AXDOMIdentifier") == expected
    }
    try require(
      boxes.count == 1 && (liveAttr(boxes[0], kAXValueAttribute) as? Int ?? 1) == 0,
      "Thread composer is not bound to the requested thread, or Also send to channel is checked; nothing was typed"
    )
  }
  return ComposerSurface(editor: editor, send: sends[0], description: description)
}

func composerIsBlank(_ editor: AXUIElement) -> Bool {
  let text = composerText(liveAttr(editor, kAXValueAttribute) as? String) ?? "?"
  return classes(editor).contains("ql-blank") && text.isEmpty
}

// Plain text of one message's authored body: the content container's children
// after its timestamp, as the reader extracts them. Rich-text and plain mrkdwn
// bodies are both covered; action bars, attachments, app context blocks and an
// open inline editor are excluded.
func messageRowText(_ row: AXUIElement) throws -> String {
  let nodes = try tree(row).map { $0.element }
  let containers = nodes.filter {
    classes($0).contains("c-message_kit__actions")
      && ancestor(
        $0, matching: { !CFEqual($0, row) && classes($0).contains("c-message_attachment") }) == nil
  }
  // A delete confirmation's message copy has no actions container: its body is
  // a direct child of the contextual message group itself.
  let outermost = containers.first(where: { candidate in
    !containers.contains { other in
      !CFEqual(other, candidate)
        && ancestor(candidate, matching: { CFEqual($0, other) }) != nil
    }
  })
  guard
    let container = outermost
      ?? (classes(row).contains("c-message_kit__contextual_message") ? row : nil)
  else { return "" }
  let children = attr(container, kAXChildrenAttribute) as? [AXUIElement] ?? []
  let timestampIndex = children.lastIndex { child in
    classes(child).contains("c-timestamp")
      || (try? tree(child).contains { classes($0.element).contains("c-timestamp") }) == true
  }
  let excluded = [
    "c-message_actions__container", "c-message_attachment", "c-message__editor__input_container",
    "c-message__reply_bar", "c-reaction_bar",
  ]
  let body = children.dropFirst(timestampIndex.map { $0 + 1 } ?? 0).filter { child in
    !classes(child).contains(where: { name in
      excluded.contains(name) || name.hasPrefix("p-context_block")
    })
  }
  var parts: [String] = []
  for child in body {
    for node in try tree(child).map({ $0.element }) where role(node) == "AXStaticText" {
      guard
        ancestor(
          node,
          matching: {
            classes($0).contains(where: { excluded.contains($0) || $0.hasPrefix("p-context_block") }
            )
          }) == nil
      else { continue }
      parts.append(liveAttr(node, kAXValueAttribute) as? String ?? "")
    }
  }
  return parts.joined(separator: " ")
}

func messageRowPermalink(_ row: AXUIElement) throws -> String? {
  try tree(row).map { $0.element }.compactMap { element -> String? in
    guard classes(element).contains("c-timestamp") else { return nil }
    return messageLink(element)?.url
  }.first
}

func setComposerValue(
  _ editor: AXUIElement, _ text: String, _ workspace: Workspace, verify: () throws -> Void
) throws {
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-compose-value")
  let result = try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) }, verifyControl: verify,
    input: { try interactionAXValue(editor, kAXValueAttribute as CFString, text as CFString) })
  try require(result == .success, "Editor did not accept text; nothing was sent")
}

// Returns nil once the text reads back, otherwise the last value observed so a
// mismatch can be described before the text is cleared.
func waitForComposerText(_ editor: AXUIElement, _ text: String) -> String?? {
  let deadline = Date().addingTimeInterval(2)
  var last: String?
  repeat {
    settle(0.2)
    last = liveAttr(editor, kAXValueAttribute) as? String
    if composerReadbackMatches(last, text) { return nil }
  } while Date() < deadline
  return .some(last)
}

// A readback mismatch stops before any Send now or Save press, so nothing was
// sent or saved. The evidence describes where the text diverged without any
// message content.
struct ReadbackFailure: Error, CustomStringConvertible {
  let description: String
  let readback: [String: Any]
}

// Letters and digits are reported only as a kind. Punctuation, symbols and
// whitespace keep their codepoint so typographic or link rewriting is visible.
func readbackKind(_ scalar: Unicode.Scalar) -> String {
  if CharacterSet.letters.contains(scalar) { return "letter" }
  if CharacterSet.decimalDigits.contains(scalar) { return "digit" }
  return String(format: "U+%04X", scalar.value)
}

func foldTypography(_ value: String) -> String {
  var folded = ""
  for scalar in value.unicodeScalars {
    switch scalar.value {
    // Only the curly pairs Slack's smart quotes produce; primes and low quotes
    // are distinct characters and must read back as typed.
    case 0x2018, 0x2019: folded.append("'")
    case 0x201C, 0x201D: folded.append("\"")
    default: folded.unicodeScalars.append(scalar)
    }
  }
  return folded
}

func readbackDivergence(_ observedValue: String?, _ text: String) -> [String: Any] {
  let shortcodes = #":[a-z0-9_+\-']+:"#
  let withoutShortcodes = text.replacingOccurrences(
    of: shortcodes, with: "", options: [.regularExpression, .caseInsensitive])
  guard let observed = composerText(observedValue) else {
    return ["observed": false, "expectedLength": text.unicodeScalars.count]
  }
  let actual = Array(observed.unicodeScalars)
  func commonPrefix(_ expected: [Unicode.Scalar]) -> Int {
    var offset = 0
    while offset < min(expected.count, actual.count) && expected[offset] == actual[offset] {
      offset += 1
    }
    return offset
  }
  // Slack may drop known shortcodes, so compare with whichever form matches longer.
  let full = Array(text.unicodeScalars)
  let stripped = Array(withoutShortcodes.unicodeScalars)
  let useStripped = stripped != full && commonPrefix(stripped) > commonPrefix(full)
  let expected = useStripped ? stripped : full
  let offset = commonPrefix(expected)
  let start = max(0, offset - 3)
  func around(_ scalars: [Unicode.Scalar]) -> [String] {
    start < scalars.count ? scalars[start..<min(scalars.count, offset + 4)].map(readbackKind) : []
  }
  func squash(_ value: String) -> String {
    value.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
      .joined(separator: " ")
  }
  let reference = useStripped ? withoutShortcodes : text
  return [
    "observed": true, "expectedLength": expected.count, "observedLength": actual.count,
    "firstDifference": offset, "windowStart": start,
    "expectedAround": around(expected), "observedAround": around(actual),
    "comparedWithoutShortcodes": useStripped,
    "equalAfterQuoteFolding": foldTypography(observed) == foldTypography(reference),
    "equalIgnoringWhitespace": squash(observed) == squash(reference),
    "observedIsPrefix": actual.count < expected.count && offset == actual.count,
  ]
}

// Clear only text this command placed, so a failed verification leaves the
// composer as it was found (empty).
func clearComposedText(_ editor: AXUIElement, _ workspace: Workspace) {
  _ = try? interactionAXValue(editor, kAXValueAttribute as CFString, "" as CFString)
  settle(0.3)
  recoverySteps.append(
    composerIsBlank(editor)
      ? "Cleared the unverified text this command entered; nothing was sent"
      : "Attempted to clear unverified text; inspect the composer before another request")
}

func sendMessage(_ text: String, _ target: [String: Any], _ workspace: Workspace) throws
  -> [String: Any]
{
  try require(validComposeText(text), "Message text is empty, too long or has control characters")
  var root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Search picker is open; nothing was typed")
  try requireNoModal(workspace.window)
  let surface = try messageComposer(root, target)
  try require(
    composerIsBlank(surface.editor),
    "The composer already holds an unsent draft; nothing was typed so the draft is preserved")
  let baseline = try pageRows(root, target).map { $0.timestamp }.max() ?? ""
  try setComposerValue(surface.editor, text, workspace) {
    let fresh = try messageComposer(workspace.root(), target)
    try require(
      CFEqual(fresh.editor, surface.editor) && composerIsBlank(fresh.editor),
      "Composer changed before typing; nothing was typed")
  }
  if let observed = waitForComposerText(surface.editor, text) {
    let readback = readbackDivergence(observed, text)
    clearComposedText(surface.editor, workspace)
    throw ReadbackFailure(
      description: "Composer text did not read back exactly; nothing was sent", readback: readback)
  }
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-send")
  do {
    try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      verifyControl: {
        let fresh = try messageComposer(workspace.root(), target)
        try require(
          CFEqual(fresh.editor, surface.editor) && CFEqual(fresh.send, surface.send)
            && composerReadbackMatches(liveAttr(fresh.editor, kAXValueAttribute) as? String, text),
          "Composer changed before sending; nothing was sent")
      }, input: { try press(surface.send) })
  } catch {
    clearComposedText(surface.editor, workspace)
    throw error
  }
  let expected = composeComparable(text)
  let deadline = Date().addingTimeInterval(12)
  var lastReason = "No new message with the sent text appeared"
  repeat {
    settle()
    try? sampleDesktop("verify-send")
    do {
      root = try workspace.root()
      let fresh = try messageComposer(root, target)
      guard composerIsBlank(fresh.editor) else {
        lastReason = "Composer has not cleared"
        continue
      }
      let rows = try pageRows(root, target).filter { $0.timestamp > baseline }
      let matches = try rows.filter {
        rowComparable(try messageRowText($0.element)).text == expected
      }
      if matches.count == 1 {
        return [
          "status": "ok", "timestamp": matches[0].timestamp,
          "permalink": try messageRowPermalink(matches[0].element) as Any? ?? NSNull(),
          "newRows": rows.count, "composer": surface.description,
        ]
      }
      lastReason =
        matches.isEmpty
        ? "No new message with the sent text appeared" : "Several new messages match the text"
    } catch {
      lastReason = String(describing: error)
    }
  } while Date() < deadline
  throw ComposeFailure(
    description:
      "Send now was pressed once, but delivery was not verified: \(lastReason). Read the conversation before any retry; do not resend blindly",
    actionMayHaveOccurred: true)
}

// MARK: - Own-message edit and delete

struct OwnMessage {
  let row: AXUIElement
  let link: MessageLink
}

// The message's row in the open conversation's main list, by DOM identity. A row
// being edited loses its timestamp link, so the permalink cannot locate it.
func messageRow(_ root: AXUIElement, _ link: MessageLink) throws -> AXUIElement? {
  guard let rows = try threadSourceRows(root, link) else { return nil }
  let matches = rows.filter { $0.timestamp == link.messageTS }
  try require(matches.count <= 1, "Requested message is exposed more than once")
  return matches.first?.element
}

// Locate the requested message in its own conversation, opening it by exact ID
// and scrolling within the read-thread bounds when it is not already exposed.
func locateOwnMessage(_ link: MessageLink, _ workspace: Workspace, _ running: NSRunningApplication)
  throws -> OwnMessage
{
  try require(
    link.threadTS == nil, "Thread replies are not supported yet; use a conversation message")
  var root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Search picker is open; nothing was changed")
  if let row = try messageRow(root, link) { return OwnMessage(row: row, link: link) }
  let url = attr(root, kAXURLAttribute) as? URL
  if url?.lastPathComponent != link.conversationId {
    try navigateMediaSourceConversation(
      MediaSourceRequest(
        workspace: workspace.context, messageRef: "\(link.conversationId):\(link.messageTS)"),
      workspace, running, Date().addingTimeInterval(30))
    recoverySteps.append("Opened the message's conversation by its exact ID")
  }
  try exposeThreadSource(link, workspace)
  root = try workspace.root()
  guard let row = try messageRow(root, link) else {
    throw Failure(
      description:
        "Requested message is not exposed after opening its conversation; read the conversation and use a fresh reference"
    )
  }
  return OwnMessage(row: row, link: link)
}

func messageActionsMenus(_ root: AXUIElement) throws -> [AXUIElement] {
  try tree(root).map { $0.element }.filter {
    role($0) == "AXMenu" && classes($0).contains("c-menu__items") && label($0) == "Message actions"
  }
}

// Only the message actions menu this command opened may be present.
func requireOnlyMessageMenu(_ root: AXUIElement, _ menu: AXUIElement) throws {
  let blockers = try tree(root).filter {
    ["AXDialog", "AXSheet", "AXMenu"].contains(role($0.element))
      || string($0.element, kAXSubroleAttribute) == "AXDialog"
      || (attr($0.element, "AXModal") as? Bool) == true
  }
  try require(
    blockers.count == 1 && CFEqual(blockers[0].element, menu),
    "Another dialog or menu is open; nothing was changed")
}

func postEscape(_ workspace: Workspace) {
  guard CGPreflightPostEventAccess(),
    CGEventSource.flagsState(.combinedSessionState).intersection([
      .maskCommand, .maskControl, .maskAlternate, .maskShift,
    ]).isEmpty, NSEvent.pressedMouseButtons == 0, (try? requireForegroundInput()) != nil
  else { return }
  AXWalkMemo.invalidate()
  CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.postToPid(workspace.pid)
  CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.postToPid(workspace.pid)
  settle(0.4)
}

// Open the row's own More actions menu and press one item identified by its
// Slack class. The menu is dismissed with Escape if the item is unavailable.
func pressMessageMenuItem(
  _ message: OwnMessage, _ itemClass: String, _ workspace: Workspace
) throws {
  let root = try workspace.root()
  try requireNoModal(workspace.window)
  try require(try messageActionsMenus(root).isEmpty, "A message menu is already open")
  // A freshly opened conversation renders a row's offscreen action bar lazily.
  var more: [AXUIElement] = []
  let controlDeadline = Date().addingTimeInterval(3)
  repeat {
    more = try tree(message.row).map { $0.element }.filter {
      role($0) == "AXPopUpButton" && label($0) == "More actions"
        && classes($0).contains("c-message_actions__button")
    }
    if more.count != 1 { settle(0.3) }
  } while more.count != 1 && Date() < controlDeadline
  try require(more.count == 1, "Message has no unique More actions control; nothing was changed")
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-message-menu")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) },
    verifyControl: {
      let fresh = try messageRow(workspace.root(), message.link)
      try require(
        fresh.map { CFEqual($0, message.row) } == true, "Message changed; nothing was changed")
    }, input: { try press(more[0]) })
  var menu: AXUIElement?
  let deadline = Date().addingTimeInterval(3)
  repeat {
    settle(0.2)
    let menus = try messageActionsMenus(workspace.root())
    if menus.count == 1 { menu = menus[0] }
  } while menu == nil && Date() < deadline
  guard let menu else {
    postEscape(workspace)
    throw Failure(description: "Message actions menu did not open; nothing was changed")
  }
  let items = try tree(menu).map { $0.element }.filter {
    role($0) == "AXMenuItem" && classes($0).contains(itemClass)
  }
  guard items.count == 1, (attr(items[0], kAXEnabledAttribute) as? Bool) == true else {
    postEscape(workspace)
    throw Failure(
      description:
        "This message does not offer that action (only your own messages can be edited or deleted); menu closed, nothing was changed"
    )
  }
  try sampleDesktop("before-message-menu-item")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireOnlyMessageMenu(workspace.root(), menu) },
    verifyControl: {
      let fresh = try tree(menu).map { $0.element }.filter {
        role($0) == "AXMenuItem" && classes($0).contains(itemClass)
      }
      try require(
        fresh.count == 1 && CFEqual(fresh[0], items[0]), "Menu changed; nothing was changed")
    }, input: { try press(items[0]) })
}

struct InlineEditor {
  let editor: AXUIElement
  let save: AXUIElement
  let cancel: AXUIElement
}

func inlineEditor(_ row: AXUIElement) throws -> InlineEditor? {
  let containers = try tree(row).map { $0.element }.filter {
    classes($0).contains("c-message__editor__input_container")
  }
  guard containers.count == 1 else { return nil }
  let nodes = try tree(containers[0]).map { $0.element }
  let editors = nodes.filter { role($0) == "AXTextArea" && classes($0).contains("ql-editor") }
  let saves = nodes.filter {
    role($0) == "AXButton" && label($0) == "Save" && classes($0).contains("c-button--primary")
  }
  let cancels = nodes.filter {
    role($0) == "AXButton" && label($0) == "Cancel" && classes($0).contains("c-button--outline")
  }
  guard editors.count == 1, saves.count == 1, cancels.count == 1 else { return nil }
  return InlineEditor(editor: editors[0], save: saves[0], cancel: cancels[0])
}

func cancelInlineEdit(_ editor: InlineEditor) {
  if (try? press(editor.cancel)) != nil {
    settle(0.4)
    recoverySteps.append("Cancelled the inline edit this command opened; the message is unchanged")
  }
}

func editMessage(
  _ link: MessageLink, _ text: String, _ workspace: Workspace, _ running: NSRunningApplication
) throws -> [String: Any] {
  try require(validComposeText(text), "Message text is empty, too long or has control characters")
  let message = try locateOwnMessage(link, workspace, running)
  try require(try inlineEditor(message.row) == nil, "This message is already being edited")
  try pressMessageMenuItem(message, "p-message_actions_menu__edit_message", workspace)
  var opened: InlineEditor?
  let openDeadline = Date().addingTimeInterval(4)
  repeat {
    settle(0.2)
    if let row = try messageRow(workspace.root(), link) { opened = try inlineEditor(row) }
  } while opened == nil && Date() < openDeadline
  guard let editor = opened else {
    throw Failure(description: "Inline editor did not open; the message is unchanged")
  }
  do {
    try setComposerValue(editor.editor, text, workspace) {
      guard let row = try messageRow(workspace.root(), link), let fresh = try inlineEditor(row),
        CFEqual(fresh.editor, editor.editor)
      else { throw Failure(description: "Inline editor changed; nothing was saved") }
    }
    if let observed = waitForComposerText(editor.editor, text) {
      throw ReadbackFailure(
        description: "Edited text did not read back exactly; nothing was saved",
        readback: readbackDivergence(observed, text))
    }
    let window = try windowId(workspace.window, workspace.pid)
    try sampleDesktop("before-save-edit")
    try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      verifyControl: {
        guard let row = try messageRow(workspace.root(), link), let fresh = try inlineEditor(row),
          CFEqual(fresh.save, editor.save),
          composerReadbackMatches(liveAttr(fresh.editor, kAXValueAttribute) as? String, text)
        else { throw Failure(description: "Inline editor changed; nothing was saved") }
      }, input: { try press(editor.save) })
  } catch {
    cancelInlineEdit(editor)
    throw error
  }
  let expected = composeComparable(text)
  let deadline = Date().addingTimeInterval(10)
  var lastReason = "Edited text did not appear"
  repeat {
    settle()
    try? sampleDesktop("verify-edit")
    do {
      guard let row = try messageRow(workspace.root(), link) else {
        lastReason = "Message is no longer exposed"
        continue
      }
      guard try inlineEditor(row) == nil else {
        lastReason = "Inline editor is still open"
        continue
      }
      let observed = rowComparable(try messageRowText(row))
      if observed.text == expected {
        return [
          "status": "ok", "timestamp": link.messageTS, "edited": observed.edited,
          "permalink": try messageRowPermalink(row) as Any? ?? NSNull(),
        ]
      }
    } catch {
      lastReason = String(describing: error)
    }
  } while Date() < deadline
  throw ComposeFailure(
    description:
      "Save was pressed once, but the edit was not verified: \(lastReason). Read the conversation before any retry",
    actionMayHaveOccurred: true)
}

struct DeleteDialog {
  let dialog: AXUIElement
  let confirm: AXUIElement
  let cancel: AXUIElement
  let messageText: String
}

func deleteDialogs(_ root: AXUIElement) throws -> [DeleteDialog] {
  try tree(root).map { $0.element }.filter {
    classes($0).contains("c-dialog__content") && label($0) == "Delete message"
  }.compactMap { dialog in
    let nodes = try tree(dialog).map { $0.element }
    let confirms = nodes.filter {
      role($0) == "AXButton" && label($0) == "Delete" && classes($0).contains("c-dialog__go")
    }
    let cancels = nodes.filter {
      role($0) == "AXButton" && label($0) == "Cancel" && classes($0).contains("c-dialog__cancel")
    }
    let contextual = nodes.filter { classes($0).contains("c-message_kit__contextual_message") }
    guard confirms.count == 1, cancels.count == 1, contextual.count == 1 else { return nil }
    return DeleteDialog(
      dialog: dialog, confirm: confirms[0], cancel: cancels[0],
      messageText: try messageRowText(contextual[0]))
  }
}

func deleteMessage(
  _ link: MessageLink, _ workspace: Workspace, _ running: NSRunningApplication
) throws -> [String: Any] {
  let message = try locateOwnMessage(link, workspace, running)
  let originalRaw = try messageRowText(message.row)
  let original = rowComparable(originalRaw).text
  try require(!original.isEmpty, "Message text is not exposed; nothing was deleted")
  try pressMessageMenuItem(message, "p-message_actions_menu__delete_message", workspace)
  var found: DeleteDialog?
  let openDeadline = Date().addingTimeInterval(4)
  repeat {
    settle(0.2)
    let dialogs = try deleteDialogs(workspace.root())
    if dialogs.count == 1 { found = dialogs[0] }
  } while found == nil && Date() < openDeadline
  guard let dialog = found else {
    throw Failure(
      description:
        "Delete confirmation did not open as expected; nothing was deleted. Inspect for an open dialog"
    )
  }
  guard sameMessageText(dialog.messageText, originalRaw) else {
    if (try? press(dialog.cancel)) != nil { settle(0.4) }
    throw Failure(
      description: "Confirmation shows a different message; cancelled, nothing was deleted")
  }
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-delete")
  do {
    try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: {},
      verifyControl: {
        let fresh = try deleteDialogs(workspace.root())
        try require(
          fresh.count == 1 && CFEqual(fresh[0].confirm, dialog.confirm)
            && sameMessageText(fresh[0].messageText, originalRaw),
          "Confirmation changed; nothing was deleted")
      }, input: { try press(dialog.confirm) })
  } catch {
    if (try? press(dialog.cancel)) != nil { settle(0.4) }
    throw error
  }
  let deadline = Date().addingTimeInterval(10)
  var lastReason = "Message is still exposed"
  repeat {
    settle()
    try? sampleDesktop("verify-delete")
    do {
      let root = try workspace.root()
      guard try deleteDialogs(root).isEmpty else {
        lastReason = "Confirmation is still open"
        continue
      }
      if let row = try messageRow(root, link) {
        // A thread root with replies is replaced by a placeholder.
        if rowComparable(try messageRowText(row)).text != original {
          return ["status": "ok", "timestamp": link.messageTS, "placeholder": true]
        }
        continue
      }
      // The row must be gone from a conversation that is still the same one.
      if (attr(root, kAXURLAttribute) as? URL)?.lastPathComponent == link.conversationId {
        return ["status": "ok", "timestamp": link.messageTS, "placeholder": false]
      }
      lastReason = "Conversation changed before deletion was verified"
    } catch {
      lastReason = String(describing: error)
    }
  } while Date() < deadline
  throw ComposeFailure(
    description:
      "Delete was confirmed once, but removal was not verified: \(lastReason). Read the conversation before any retry",
    actionMayHaveOccurred: true)
}
