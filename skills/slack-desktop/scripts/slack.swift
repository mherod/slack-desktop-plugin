import AppKit
import ApplicationServices
import Darwin

var interrupted = false
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
interruptSource.setEventHandler { interrupted = true }
terminateSource.setEventHandler { interrupted = true }
interruptSource.resume()
terminateSource.resume()

// Narrow desktop helper: no arbitrary key, click or AX action command. Composer
// input is limited to the guarded send/edit/delete flows in SlackCompose.swift.
struct SlackAXProbe {
  let status: String
  var pid: pid_t?
  var checkedAttributes: [String] = []
  var childCount: Int?
  var error: AXError?
  var operation: String?
  var reason: String?
  var accessible: Bool { status == "accessible" }
  var exitCode: Int32 { accessible ? 0 : status == "api-disabled" ? 3 : 1 }
  var accessStatus: String { status == "api-disabled" ? "permission-required" : "unavailable" }
  var receipt: [String: Any] {
    var value: [String: Any] = ["status": status, "checkedAttributes": checkedAttributes]
    if let pid { value["pid"] = pid }
    if let childCount { value["childCount"] = childCount }
    if let error {
      value["error"] = [
        "code": error.rawValue, "name": axErrorName(error), "operation": operation ?? "unknown",
      ]
    }
    if let reason { value["reason"] = reason }
    return value
  }
  var message: String {
    if status == "api-disabled" {
      return
        "Slack accessibility API is disabled in this execution context; a trusted-process flag alone does not establish AX access. No command input was attempted"
    }
    if status == "not-running" {
      return "Slack is not running; accessibility access was not verified"
    }
    if status == "ambiguous" {
      return "Multiple running Slack applications prevent an unambiguous accessibility probe"
    }
    if let error {
      return
        "Slack accessibility probe failed at \(operation ?? "unknown") with \(axErrorName(error)) (\(error.rawValue)); workspace access is unverified and no command input was attempted"
    }
    return
      "Slack accessibility application data is unavailable or malformed; workspace access is unverified and no command input was attempted"
  }
  var next: String {
    if status == "api-disabled" {
      return permissionRecoveryGuidance()
    }
    if status == "not-running" { return "Open Slack, then rerun permissions from the same host." }
    if status == "ambiguous" {
      return "Leave one running Slack application, then rerun permissions from the same host."
    }
    return
      "Check that Slack is responsive, then rerun permissions and inspect --ui from the same host. The failed AX result does not establish missing permission or a sign-in problem."
  }
}
struct SlackAXAccessFailure: Error, CustomStringConvertible {
  let probe: SlackAXProbe
  var description: String { probe.message }
}
// Trust and target readability are separate evidence. Each read is attempted once;
// empty children establish access, never a ready or verified workspace.
func readSlackAXProbe(
  pid: pid_t, configure: () -> AXError,
  read: (String) -> (AXError, CFTypeRef?)
) -> SlackAXProbe {
  var checked: [String] = []
  func failed(_ result: AXError, _ operation: String) -> SlackAXProbe {
    SlackAXProbe(
      status: result == .apiDisabled ? "api-disabled" : "unavailable", pid: pid,
      checkedAttributes: checked, error: result, operation: operation)
  }
  let configured = configure()
  guard configured == .success else { return failed(configured, "messaging-timeout") }
  checked.append(kAXRoleAttribute)
  let (roleResult, roleValue) = read(kAXRoleAttribute)
  guard roleResult == .success else { return failed(roleResult, kAXRoleAttribute) }
  guard roleValue as? String == "AXApplication" else {
    return SlackAXProbe(
      status: "unavailable", pid: pid, checkedAttributes: checked,
      reason: "unexpected-application-role")
  }
  checked.append(kAXChildrenAttribute)
  let (childrenResult, childrenValue) = read(kAXChildrenAttribute)
  guard childrenResult == .success else { return failed(childrenResult, kAXChildrenAttribute) }
  guard let childrenValue, CFGetTypeID(childrenValue) == CFArrayGetTypeID(),
    let children = childrenValue as? [CFTypeRef],
    children.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() })
  else {
    return SlackAXProbe(
      status: "unavailable", pid: pid, checkedAttributes: checked,
      reason: "invalid-children-array")
  }
  return SlackAXProbe(
    status: "accessible", pid: pid, checkedAttributes: checked, childCount: children.count)
}
func slackAXProbe(_ app: AXUIElement, _ pid: pid_t) -> SlackAXProbe {
  readSlackAXProbe(
    pid: pid, configure: { AXUIElementSetMessagingTimeout(app, 1) },
    read: { attribute in
      var value: CFTypeRef?
      let result = AXUIElementCopyAttributeValue(app, attribute as CFString, &value)
      return (result, value)
    })
}
func selectedSlackAXProbe(_ trusted: Bool) -> SlackAXProbe {
  guard trusted else {
    return SlackAXProbe(status: "not-checked", reason: "accessibility-trust-missing")
  }
  let apps = NSRunningApplication.runningApplications(
    withBundleIdentifier: "com.tinyspeck.slackmacgap"
  )
  .filter { !$0.isTerminated }
  guard apps.count == 1 else {
    return SlackAXProbe(status: apps.isEmpty ? "not-running" : "ambiguous")
  }
  return slackAXProbe(
    AXUIElementCreateApplication(apps[0].processIdentifier), apps[0].processIdentifier)
}
func permissionState(_ trusted: Bool, _ postEvent: Bool, _ probe: SlackAXProbe) -> (String, Int32) {
  if !trusted || probe.status == "api-disabled" { return ("permission-required", 3) }
  if !probe.accessible { return ("unavailable", 1) }
  return (postEvent ? "ready" : "inspection-only", 0)
}
func permissionRecoveryGuidance(inspectionOnly: Bool = false) -> String {
  let context =
    "Verify the intended execution host and its approved access first. If the execution tool restricts host access, use its normal approval mechanism, then rerun read-only permissions. Stop if approval is denied. Do not bypass a denied resource. "
  let setup =
    inspectionOnly
    ? "Only if keyboard access is still unavailable in that approved context, check the host's input/Accessibility access in System Settings, then rerun permissions; keyboard navigation requires ready access. Read-only inspection remains available. "
    : "Only if access is still unavailable in that approved context, explicitly run permissions --request for macOS Accessibility setup and enable the identity macOS names. Rerun permissions there; rerun the original command only after access is ready. "
  return context + setup
    + "No permission is granted and no command is replayed. Inspect any earlier action outcome before retrying."
}
func permissionReceipt(
  _ trusted: Bool, _ postEvent: Bool, _ probe: SlackAXProbe,
  promptRequested: Bool = false, settingsOpenRequested: Bool = false, executable: String
) -> [String: Any] {
  [
    "operation": "permissions", "status": permissionState(trusted, postEvent, probe).0,
    "permissionScope": "current-execution-context",
    "accessibilityTrusted": trusted,
    "postEventAccess": postEvent, "accessibilityProbe": probe.receipt,
    "promptRequested": promptRequested,
    "settingsOpenRequested": settingsOpenRequested,
    "executable": executable,
    "next": !trusted
      ? permissionRecoveryGuidance()
      : !probe.accessible
        ? probe.next
        : postEvent
          ? "Slack AX application reads succeeded in this execution context. Run the requested command; its workspace and source still require verification."
          : permissionRecoveryGuidance(inspectionOnly: true),
    "note":
      "Trust, target AX reads and post-event access describe this execution context; these checks cannot distinguish execution restrictions from missing macOS approval. The probe reads only Slack's application role and children, not message content or workspace identity. Prompting is asynchronous; opening settings never grants access or resumes input. Rebuilt ad-hoc signed helpers may require renewed approval.",
  ]
}
var foregroundInteraction: ForegroundInteraction?
var firstPickerRejectionStructure: [String: Any]?
var firstDMNamedGroupRejection: [String: Any]?
var firstGroupPickerRejection: [String: Any]?
func pickerFailureReceipt(_ receipt: [String: Any], _ diagnostic: [String: Any]?) -> [String: Any] {
  var result = receipt
  if result["error"] != nil, let diagnostic {
    result["pickerStructure"] = diagnostic
  }
  return result
}
func emit(_ value: [String: Any]) throws {
  let scoped = workspaceScopedEmission(value)
  var receipt = pickerFailureReceipt(scoped.receipt, firstPickerRejectionStructure)
  if let foregroundInteraction { receipt["interaction"] = foregroundInteraction.receipt }
  if receipt["error"] != nil, let firstCaptureConflict {
    receipt["captureConflict"] = firstCaptureConflict.receipt
  }
  if receipt["error"] != nil, let firstDMNamedGroupRejection {
    receipt["namedGroupStructure"] = firstDMNamedGroupRejection
  }
  if receipt["error"] != nil, let firstGroupPickerRejection {
    receipt["groupPickerState"] = firstGroupPickerRejection
  }
  let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  if scoped.scopeFailed {
    fflush(stdout)
    exit(1)
  }
}
// Prompting is asynchronous; it never grants access or authorizes queued input.
func permissions(request: Bool) throws -> Int32 {
  let trusted = AXIsProcessTrusted()
  let postEvent = CGPreflightPostEventAccess()
  let probe = selectedSlackAXProbe(trusted)
  let (_, exitCode) = permissionState(trusted, postEvent, probe)
  var promptRequested = false
  var settingsOpened = false
  if request && (!trusted || probe.status == "api-disabled") {
    let options =
      [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    promptRequested = true
    if let url = URL(
      string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    {
      settingsOpened = NSWorkspace.shared.open(url)
    }
  }
  try emit(
    permissionReceipt(
      trusted, postEvent, probe, promptRequested: promptRequested,
      settingsOpenRequested: settingsOpened,
      executable: URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path))
  return exitCode
}
var desktopSamples: [[String: Any]] = []
var initialForeground: pid_t = 0
var slackPid: pid_t = 0
func queryFields(_ root: AXUIElement) throws -> [Node] {
  // The Directories page has its own "Query" search box; it is page content,
  // not the Search picker overlay.
  try tree(root).filter {
    role($0.element) == "AXComboBox" && label($0.element) == "Query"
      && ancestor(
        $0.element,
        matching: { classes($0).contains(where: { $0.hasPrefix("unifiedDirectoryTabsPanel") }) })
        == nil
  }
}
func searchButton(_ node: Node) -> Bool {
  role(node.element) == "AXButton"
    && (label(node.element) == "Search" || label(node.element).hasPrefix("Search: "))
}
func mainClient(_ app: AXUIElement) throws -> AXUIElement {
  func isClient(_ element: AXUIElement) -> Bool {
    let values = liveAttrs(element, [kAXRoleAttribute, kAXURLAttribute])
    return values[0] as? String == "AXWebArea" && (values[1] as? URL)?.host == "app.slack.com"
  }
  func isSurface(_ node: Node) -> Bool {
    searchButton(node) || (role(node.element) == "AXComboBox" && label(node.element) == "Query")
  }
  // Within one quiet interval the proven client is reused after a live check
  // that it is still a Slack client; anything that can change Slack forgets it.
  if let proven = AXWalkMemo.provenClient(in: app), isClient(proven) { return proven }
  // One walk of the app covers every client's subtree: a client owns a search
  // surface when it is on that surface's ancestor chain.
  let nodes = try tree(app)
  let clients = nodes.indices.filter { isClient(nodes[$0].element) }
  let clientSet = Set(clients)
  var owners = Set<Int>()
  for index in nodes.indices where owners.count < clients.count {
    var enclosing: [Int] = []
    var cursor = index
    while cursor >= 0 {
      if clientSet.contains(cursor) { enclosing.append(cursor) }
      cursor = nodes[cursor].parent
    }
    if enclosing.allSatisfy(owners.contains) { continue }
    if isSurface(nodes[index]) { owners.formUnion(enclosing) }
  }
  // A client with no surface on its first-reached chain is still walked on its
  // own, so an aliased subtree cannot hide a second workspace window.
  let main = try clients.filter { index in
    try owners.contains(index) || tree(nodes[index].element).contains(where: isSurface)
  }.map { nodes[$0] }
  try require(
    !main.isEmpty,
    "Slack has no ready workspace search surface; finish sign-in or dismiss the blocking window, then retry"
  )
  try require(
    main.count == 1,
    "Multiple Slack workspace windows are exposed; leave one workspace window open before retrying")
  AXWalkMemo.rememberClient(main[0].element, in: app)
  return main[0].element
}
var recoverySteps: [String] = []
// Electron may expose a basic AX tree without actionable controls. Enable full
// accessibility once; repeated writes restart Electron's two-second debounce.
func prepareAccessibility(_ app: AXUIElement, control: ((Node) -> Bool)? = nil) throws {
  func ready() -> Bool {
    guard let root = try? mainClient(app), let nodes = try? tree(root) else { return false }
    if control == nil, (try? requireQueryFocus(root)) != nil { return true }
    let targets = nodes.filter(control ?? searchButton)
    return targets.count == 1 && actions(targets[0].element).contains(kAXPressAction)
  }
  if ready() { return }
  try sampleDesktop("before-accessibility-init")
  AXWalkMemo.invalidate()
  let result = AXUIElementSetAttributeValue(
    app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  recoverySteps.append(
    result == .success
      ? "Requested full Electron accessibility"
      : "Full Electron accessibility request unavailable (\(result.rawValue))")
  let deadline = Date().addingTimeInterval(3.5)
  while Date() < deadline && !ready() {
    settle()
    try sampleDesktop("wait-accessibility-init")
  }
  try sampleDesktop("after-accessibility-init")
}
func focusedNodes(_ root: AXUIElement) throws -> [Node] {
  try tree(root).filter { (attr($0.element, kAXFocusedAttribute) as? Bool) == true }
}
// Capture only the rejected control's shape before recovery can close its picker.
// This evidence never changes which controls are accepted for navigation.
func pickerRejectionStructure<T: Hashable>(
  _ root: T, now: () -> Date = { Date() },
  read: (T) -> (fields: [String: Any], children: [T]?)
) -> [String: Any] {
  let deadline = now().addingTimeInterval(1)
  var seen = Set<T>()
  var nodes: [[String: Any]] = []
  var limits = Set<String>()
  func bounded(_ value: String) -> String {
    if value.unicodeScalars.count > 200 { limits.insert("field-limit") }
    return String(String.UnicodeScalarView(value.unicodeScalars.prefix(200)))
  }
  func visit(_ item: T, _ parent: Int?, _ depth: Int) {
    guard nodes.count < 12 else {
      limits.insert("node-limit")
      return
    }
    guard now() < deadline else {
      limits.insert("time-limit")
      return
    }
    guard seen.insert(item).inserted else {
      limits.insert("repeated-node")
      return
    }
    let observed = read(item)
    let index = nodes.count
    var node: [String: Any] = [
      "index": index, "parent": parent as Any? ?? NSNull(), "depth": depth,
      "childCount": observed.children?.count as Any? ?? NSNull(),
      "role": (observed.fields["role"] as? String).map(bounded) as Any? ?? NSNull(),
    ]
    for key in ["classes", "actions"] {
      if let values = observed.fields[key] as? [String] {
        if values.count > 16 { limits.insert("field-limit") }
        node[key] = values.prefix(16).map(bounded)
      } else {
        node[key] = NSNull()
      }
    }
    for key in ["enabled", "focused"] {
      node[key] = (observed.fields[key] as? Bool) as Any? ?? NSNull()
    }
    nodes.append(node)
    guard let children = observed.children else {
      limits.insert("children-unavailable")
      return
    }
    if depth == 3 {
      if !children.isEmpty { limits.insert("depth-limit") }
      return
    }
    for child in children {
      if nodes.count == 12 {
        limits.insert("node-limit")
        break
      }
      if now() >= deadline {
        limits.insert("time-limit")
        break
      }
      visit(child, index, depth + 1)
    }
  }
  visit(root, nil, 0)
  return [
    "structuralFieldsOnly": true, "maxDepth": 3, "maxNodes": 12,
    "nodes": nodes, "returnedCount": nodes.count, "truncated": !limits.isEmpty,
    "limits": limits.sorted(),
  ]
}
func capturePickerRejectionStructure(_ element: AXUIElement) -> [String: Any] {
  pickerRejectionStructure(AXIdentity(element: element)) { identity in
    let names = [
      kAXRoleAttribute, "AXDOMClassList", kAXEnabledAttribute, kAXFocusedAttribute,
      kAXChildrenAttribute,
    ]
    let values = liveAttrs(identity.element, names)
    var fields: [String: Any] = [:]
    for (index, output) in ["role", "classes", "enabled", "focused"].enumerated() {
      fields[output] = values[index]
    }
    var actionNames: CFArray?
    if AXUIElementCopyActionNames(identity.element, &actionNames) == .success {
      fields["actions"] = actionNames as? [String]
    }
    let children = (values[4] as? [AXUIElement])?.map {
      AXIdentity(element: $0)
    }
    return (fields, children)
  }
}
struct PickerHeadingShape<T: Hashable> {
  let role: String
  let classes: [String]
  let actions: [String]?
  let focused: Bool?
  let children: [T]?
}
func pickerWrappedHeading<T: Hashable>(
  _ root: T, read: (T) -> PickerHeadingShape<T>
) -> Bool {
  func passive(_ node: PickerHeadingShape<T>) -> Bool {
    guard node.focused == false, let actions = node.actions else { return false }
    return Set(actions).isSubset(of: ["AXShowMenu", "AXScrollToVisible"])
  }
  let heading = read(root)
  let requiredClasses = Set([
    "c-search_autocomplete_section_header", "c-search_autocomplete_section_header--ia4",
  ])
  let observedClasses = Set(heading.classes)
  guard heading.role == "AXHeading", passive(heading),
    observedClasses == requiredClasses
      || observedClasses == requiredClasses.union(["c-search_autocomplete_section_header--first"]),
    let headingChildren = heading.children, headingChildren.count == 1,
    headingChildren[0] != root
  else { return false }
  let group = read(headingChildren[0])
  guard group.role == "AXGroup", passive(group),
    group.classes == ["c-search_autocomplete__header_label_text"],
    let groupChildren = group.children, groupChildren.count == 1,
    Set([root, headingChildren[0], groupChildren[0]]).count == 3
  else { return false }
  let text = read(groupChildren[0])
  return text.role == "AXStaticText" && text.classes.isEmpty && passive(text)
    && text.children?.isEmpty == true
}
func pickerWrappedHeading(_ element: AXUIElement) -> Bool {
  pickerWrappedHeading(AXIdentity(element: element)) { identity in
    let values = liveAttrs(
      identity.element,
      [kAXRoleAttribute, "AXDOMClassList", kAXFocusedAttribute, kAXChildrenAttribute])
    guard let nodeRole = values[0] as? String, let nodeClasses = values[1] as? [String] else {
      return PickerHeadingShape(role: "", classes: [], actions: nil, focused: nil, children: nil)
    }
    var rawActions: CFArray?
    let result = AXUIElementCopyActionNames(identity.element, &rawActions)
    return PickerHeadingShape(
      role: nodeRole, classes: nodeClasses,
      actions: result == .success ? rawActions as? [String] : nil,
      focused: values[2] as? Bool,
      children: (values[3] as? [AXUIElement])?.map { AXIdentity(element: $0) })
  }
}
// Layout groups may be inserted around options; traverse only passive groups,
// preserving order and rejecting aliases, cycles and unexpected controls.
func pickerOptionLeaves<T: Hashable>(
  _ roots: [T], children: (T) -> [T], kind: (T) -> String
) throws -> [T] {
  var seen = Set<T>()
  var result: [T] = []
  func visit(_ item: T, _ depth: Int) throws {
    try require(
      depth <= 6 && seen.count < 200 && seen.insert(item).inserted,
      "Search suggestion structure is repeated or exceeds bounds; input withheld")
    let observed = kind(item)
    switch observed {
    case "option": result.append(item)
    case "wrapper":
      for child in children(item) { try visit(child, depth + 1) }
    case "decoration": break
    default:
      throw Failure(
        description: "Unsupported control in Search suggestions (\(observed)); input withheld")
    }
  }
  for item in roots { try visit(item, 0) }
  return result
}
func pickerSuggestions(_ root: AXUIElement) throws -> [Node] {
  let fields = try queryFields(root)
  try require(fields.count == 1, "Query unavailable or ambiguous; input withheld")
  let wrappers = try tree(root).filter { classes($0.element).contains("c-search_modal__wrapper") }
  try require(
    wrappers.count == 1
      && (try queryFields(wrappers[0].element)).contains { CFEqual($0.element, fields[0].element) },
    "Query picker ownership unavailable; input withheld")
  let lists = try tree(wrappers[0].element).filter {
    role($0.element) == "AXList"
      && string($0.element, "AXDOMIdentifier") == "c-search_autocomplete__suggestion_list"
  }
  try require(lists.count <= 1, "Query suggestion list ambiguous; input withheld")
  // Autocomplete may briefly remove its list while loading a new query.
  if lists.isEmpty { return [] }
  let roots = accessibilityChildren(lists[0].element).map { AXIdentity(element: $0) }
  let leaves = try pickerOptionLeaves(
    roots,
    children: { identity in
      accessibilityChildren(identity.element).map { AXIdentity(element: $0) }
    },
    kind: { identity in
      let element = identity.element
      if isSuggestion(Node(element: element, depth: 0)) { return "option" }
      let nodeRole = role(element)
      let passive =
        !actions(element).contains(kAXPressAction)
        && (attr(element, kAXFocusedAttribute) as? Bool) != true
      if nodeRole == "AXGroup" && passive { return "wrapper" }
      // Section dividers are exposed as AXSeparator or, with the
      // c-search_autocomplete__divider class, as AXSplitter.
      if ["AXStaticText", "AXSeparator", "AXSplitter"].contains(nodeRole) && passive
        && accessibilityChildren(element).isEmpty
      {
        return "decoration"
      }
      // Section headings such as "Recent searches" hold only passive text.
      if nodeRole == "AXHeading" && passive
        && accessibilityChildren(element).allSatisfy({
          role($0) == "AXStaticText" && accessibilityChildren($0).isEmpty
            && !actions($0).contains(kAXPressAction)
        })
      {
        return "decoration"
      }
      // The observed section-header variant wraps one passive text leaf in a
      // specifically identified group; arbitrary nested headings remain refused.
      if nodeRole == "AXHeading" && passive && pickerWrappedHeading(element) {
        return "decoration"
      }
      if firstPickerRejectionStructure == nil {
        firstPickerRejectionStructure = capturePickerRejectionStructure(element)
      }
      return "unsupported \(nodeRole)\(passive ? "" : ", interactive")"
    })
  return leaves.map { Node(element: $0.element, depth: 0) }
}
func requireQueryFocus(_ root: AXUIElement) throws {
  let fields = try queryFields(root)
  let focused = try focusedNodes(root)
  try require(
    fields.count == 1 && focused.count == 1,
    "Search picker focus is unavailable or ambiguous; input withheld")
  if CFEqual(fields[0].element, focused[0].element) { return }
  let selected = try pickerSuggestions(root).filter {
    (attr($0.element, kAXSelectedAttribute) as? Bool) == true
  }
  // Full Chromium AX mode reports the combobox's active descendant as focused.
  let pickerFocus = selected.count == 1 && CFEqual(selected[0].element, focused[0].element)
  try require(
    pickerFocus,
    "Search Query or its selected suggestion does not own focus; input withheld. Focus the search field, then retry"
  )
}
func requireNoModal(_ root: AXUIElement) throws {
  let blockers = try tree(root).filter {
    ["AXDialog", "AXSheet", "AXMenu"].contains(role($0.element))
      || string($0.element, kAXSubroleAttribute) == "AXDialog"
      || (attr($0.element, "AXModal") as? Bool) == true
  }
  for blocker in blockers {
    // Some Slack versions wrap the known Search picker in a dialog.
    try require(
      role(blocker.element) != "AXMenu" && (try queryFields(blocker.element)).count == 1,
      "Slack has an open dialog or menu; dismiss it before navigation. No arbitrary Escape or confirmation was sent"
    )
  }
}
// Some Slack builds accept AXPress on navigation controls without acting on it,
// or stop advertising it on sidebar rows, while the same control still opens on
// Return once focused. Activation keeps AXPress first and falls back to one
// focus-plus-Return only when the caller's verified after-state stays absent.
enum ActivationMethod: String {
  case press = "AXPress"
  case focusReturn = "focus+Return"
}
struct FocusReturnEvidence: Equatable {
  let targetFocused: Bool
  let otherFocusedEditable: Bool
  let queryOpen: Bool
  let windowMatches: Bool
  let alreadyOpened: Bool
  let inputHeld: Bool
}
// Return goes to whatever holds focus, so it is posted only when the exact
// target owns focus and no composer, text field or Search picker could take it.
func focusReturnBlocker(_ evidence: FocusReturnEvidence) -> String? {
  if evidence.alreadyOpened { return nil }
  if !evidence.windowMatches { return "Slack window changed before Return; input withheld" }
  if evidence.queryOpen { return "Search picker is open; navigation Return withheld" }
  if evidence.otherFocusedEditable {
    return "A text field or composer holds focus; Return withheld so no draft or query is submitted"
  }
  if !evidence.targetFocused { return "Control did not take focus; Return withheld" }
  if evidence.inputHeld { return "Physical input held; input withheld" }
  return nil
}
func editableFocus(_ role: String, _ classes: [String]) -> Bool {
  ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"].contains(role)
    || classes.contains("ql-editor")
}
func activate(
  _ element: AXUIElement, focusTarget: AXUIElement? = nil, _ workspace: Workspace,
  window expected: Int, what: String, inputDeadline: Date? = nil, pressWait: TimeInterval = 2,
  opened: () throws -> Bool
) throws -> ActivationMethod {
  let target = focusTarget ?? element
  if (attr(element, kAXEnabledAttribute) as? Bool) == true,
    actions(element).contains(kAXPressAction)
  {
    try requireGroupLookupBudget(inputDeadline)
    try require(
      try interactionAXAction(element, kAXPressAction as CFString) == .success,
      "\(what) did not accept AXPress; no coordinate fallback attempted")
    let until = min(Date().addingTimeInterval(pressWait), inputDeadline ?? .distantFuture)
    repeat {
      if try opened() { return .press }
      settle(0.1)
    } while Date() < until
    if try opened() { return .press }
  }
  return try focusReturnActivation(
    target, workspace, window: expected, what: what, inputDeadline: inputDeadline, opened: opened)
}
// The keyboard half of activation: focus the exact control and post one
// Return only when it alone owns focus. `beforeReturn` lets a caller re-verify
// its own state immediately before the key is posted.
func focusReturnActivation(
  _ target: AXUIElement, _ workspace: Workspace, window expected: Int, what: String,
  inputDeadline: Date? = nil, opened: () throws -> Bool, beforeReturn: () throws -> Void = {}
) throws -> ActivationMethod {
  try require(
    (attr(target, kAXEnabledAttribute) as? Bool) != false,
    "\(what) is disabled; input withheld")
  var settable: DarwinBoolean = false
  try require(
    AXUIElementIsAttributeSettable(target, kAXFocusedAttribute as CFString, &settable) == .success
      && settable.boolValue,
    "\(what) ignored AXPress and cannot take focus; no keyboard fallback attempted")
  try requireGroupLookupBudget(inputDeadline)
  try sampleDesktop("before-focus-activation")
  try require(
    try windowId(workspace.window, workspace.pid) == expected,
    "Slack window changed before \(what) focus; input withheld")
  try requireNoModal(workspace.window)
  try require(
    try queryFields(workspace.root()).isEmpty,
    "Search picker is open; \(what) focus withheld")
  try require(
    try interactionAXValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success,
    "\(what) refused focus; Return withheld")
  settle(0.15)
  let root = try workspace.root()
  let focused = try focusedNodes(root)
  let evidence = FocusReturnEvidence(
    targetFocused: liveAttr(target, kAXFocusedAttribute) as? Bool == true
      && focused.contains { CFEqual($0.element, target) },
    otherFocusedEditable: focused.contains {
      !CFEqual($0.element, target) && editableFocus(role($0.element), classes($0.element))
    },
    queryOpen: try !queryFields(root).isEmpty,
    windowMatches: try windowId(workspace.window, workspace.pid) == expected,
    alreadyOpened: try opened(),
    inputHeld: !CGEventSource.flagsState(.combinedSessionState).intersection([
      .maskCommand, .maskControl, .maskAlternate, .maskShift,
    ]).isEmpty || NSEvent.pressedMouseButtons != 0)
  if evidence.alreadyOpened {
    recoverySteps.append("\(what) opened after AXPress while focus was being prepared")
    return .press
  }
  if let blocker = focusReturnBlocker(evidence) { throw Failure(description: blocker) }
  try requireNoModal(workspace.window)
  try beforeReturn()
  try require(
    CGPreflightPostEventAccess(),
    "Post-event access unavailable in this execution context; input withheld. Run read-only permissions through the runner's approved execution context before considering macOS setup; do not replay input automatically"
  )
  func event(_ type: NSEvent.EventType) -> CGEvent? {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: expected, context: nil,
      characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)?.cgEvent
  }
  guard let down = event(.keyDown), let emergencyUp = event(.keyUp) else {
    throw Failure(description: "Cannot construct key event")
  }
  do {
    try requireGroupLookupBudget(inputDeadline)
    try requireForegroundInput()
    AXWalkMemo.invalidate()
    defer { (event(.keyUp) ?? emergencyUp).postToPid(workspace.pid) }
    down.postToPid(workspace.pid)
    axPause(until: Date().addingTimeInterval(0.04))
  }
  try sampleDesktop("after-focus-activation")
  recoverySteps.append(
    "\(what) ignored AXPress; activated it once with focus and one targeted Return")
  return .focusReturn
}
// Reacquire renderer roots after transitions, without switching workspace/window.
struct Workspace {
  let app: AXUIElement
  let window: AXUIElement
  let context: String
  let pid: pid_t
  init(_ app: AXUIElement, _ pid: pid_t) throws {
    let root = try mainClient(app)
    guard let raw = attr(root, kAXWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID(),
      let url = attr(root, kAXURLAttribute) as? URL, url.pathComponents.count >= 3
    else { throw Failure(description: "Slack workspace/window identity unavailable") }
    self.app = app
    self.window = raw as! AXUIElement
    self.pid = pid
    self.context = url.pathComponents.prefix(3).joined(separator: "/")
  }
  func root() throws -> AXUIElement {
    let root = try mainClient(app)
    guard let raw = attr(root, kAXWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID(),
      let url = attr(root, kAXURLAttribute) as? URL
    else { throw Failure(description: "Slack workspace disappeared") }
    try require(
      CFEqual(raw, window) && url.pathComponents.prefix(3).joined(separator: "/") == context,
      "Slack workspace/window changed; input withheld")
    return root
  }
}
enum Destination { case search, channel, dm, group }
func groupDMName(_ query: String) throws -> String? {
  guard query.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("group-name:") else {
    return nil
  }
  let name = String(query.dropFirst("group-name:".count))
  try require(
    query.hasPrefix("group-name:") && validDMSearchText(name),
    "Group-name references require an exact name of 1–200 characters without controls")
  return name
}
func groupDMIdentifier(_ query: String) throws -> String? {
  guard query.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("group:") else {
    return nil
  }
  let identifier = String(query.dropFirst("group:".count))
  try require(
    query.hasPrefix("group:")
      && identifier.range(of: #"^[CG][A-Z0-9]+$"#, options: .regularExpression)
        == identifier.startIndex..<identifier.endIndex,
    "Group DM reference must be group: followed by a known C/G conversation ID in the current workspace"
  )
  return identifier
}
struct DestinationChoiceFailure: Error, CustomStringConvertible {
  let query: String
  let candidates: [[String: Any]]
  let candidateCount: Int
  let ambiguous: Bool
  var exactMatchCount: Int = 0
  var incomplete: Bool = false
  var description: String {
    if incomplete {
      return "Direct DMs lookup has unexposed or uncounted suggestions; no conversation selected"
    }
    return ambiguous
      ? "An exact DM destination could not be selected uniquely; Return withheld"
      : "No exact DM destination matched; Return withheld"
  }
}
struct GroupPickerFieldState {
  let value: String?
  let range: CFRange?
  let ranges: [CFRange?]?
  let focused: Bool?
  let matchesRetained: Bool
}
struct GroupPickerOptionState {
  let role: String
  let label: String
  let classes: [String]
  let selected: Bool?
  let matchesRetained: Bool?
  let exactQueryOption: Bool
  let hasPress: Bool?
  let hasShowMenu: Bool?
  var actionReadStatus: Int32? = nil
  var matchesRetainedQueryOption: Bool? = nil
}
struct GroupPickerActionInventory {
  let status: AXError
  let names: [String]?
}
func groupPickerActions(_ status: AXError, _ raw: CFTypeRef?) -> GroupPickerActionInventory {
  GroupPickerActionInventory(status: status, names: status == .success ? raw as? [String] : nil)
}
func readGroupPickerActions(_ element: AXUIElement) -> GroupPickerActionInventory {
  var raw: CFArray?
  let status = AXUIElementCopyActionNames(element, &raw)
  return groupPickerActions(status, raw)
}
func groupPickerRange(_ raw: CFTypeRef?) -> CFRange? {
  guard let raw, CFGetTypeID(raw) == AXValueGetTypeID(),
    AXValueGetType(raw as! AXValue) == .cfRange
  else { return nil }
  var value = CFRange(location: 0, length: 0)
  return AXValueGetValue(raw as! AXValue, .cfRange, &value) ? value : nil
}
func groupPickerFailureDiagnostic(
  _ requested: String, fields: [GroupPickerFieldState], options: [GroupPickerOptionState],
  retainedCandidate: Bool, allowPending: Bool, fieldCount: Int? = nil, optionCount: Int? = nil
) -> [String: Any] {
  func text(_ value: String, _ limit: Int = 500) -> String {
    String(String.UnicodeScalarView(value.unicodeScalars.prefix(limit)))
  }
  func range(_ value: CFRange) -> [String: Int] {
    ["location": value.location, "length": value.length]
  }
  return [
    "requestedID": text(requested), "allowPending": allowPending,
    "retainedCandidate": retainedCandidate,
    "fieldCount": fieldCount ?? fields.count, "optionCount": optionCount ?? options.count,
    "truncated": (fieldCount ?? fields.count) > 2 || (optionCount ?? options.count) > 20,
    "fields": fields.prefix(2).map { field -> [String: Any] in
      [
        "value": field.value.map { text($0) } as Any? ?? NSNull(),
        "valueTruncated": field.value.map { $0.unicodeScalars.count > 500 } as Any? ?? NSNull(),
        "valueUTF16Length": field.value?.utf16.count as Any? ?? NSNull(),
        "selectedRange": field.range.map(range) as Any? ?? NSNull(),
        "selectedRanges": field.ranges.map {
          $0.prefix(8).map { $0.map(range) as Any? ?? NSNull() }
        } as Any? ?? NSNull(),
        "selectedRangeCount": field.ranges?.count as Any? ?? NSNull(),
        "focused": field.focused as Any? ?? NSNull(),
        "matchesRetainedField": field.matchesRetained,
      ]
    },
    "options": options.prefix(20).map { option -> [String: Any] in
      [
        "role": text(option.role, 80), "label": text(option.label),
        "labelTruncated": option.label.unicodeScalars.count > 500,
        "classes": option.classes.prefix(16).map { text($0, 120) },
        "classCount": option.classes.count, "selected": option.selected as Any? ?? NSNull(),
        "matchesRetainedCandidate": option.matchesRetained as Any? ?? NSNull(),
        "exactQueryOption": option.exactQueryOption,
        "hasAXPress": option.hasPress as Any? ?? NSNull(),
        "hasAXShowMenu": option.hasShowMenu as Any? ?? NSNull(),
        "actionReadStatus": option.actionReadStatus as Any? ?? NSNull(),
        "matchesRetainedQueryOption": option.matchesRetainedQueryOption as Any? ?? NSNull(),
      ]
    },
  ]
}
func choiceQueryPresentationMatches(
  _ value: String, _ query: String, _ options: [(label: String, classes: [String])]
) -> Bool {
  guard value == "\(query) — Search" || value == "\(query) – Search" else { return false }
  let previews = options.filter {
    $0.classes.contains("c-search_autocomplete__suggestion_item--query")
      && $0.classes.contains("c-search_autocomplete__suggestion_item--pseudo-selected")
  }
  return previews.count == 1 && previews[0].label == "Search for: \(query)"
}
func choiceQueryMatches(_ field: AXUIElement, _ query: String, _ options: [Node]) -> Bool {
  let value = string(field, kAXValueAttribute)
  if value == query { return true }
  // Slack exposes non-selected em-dash and en-dash Search presentation suffixes.
  // Bind it to the exact pseudo-selected query option, never a prefix match.
  if value == "\(query) — Search" || value == "\(query) – Search" {
    return choiceQueryPresentationMatches(
      value, query, options.map { (label($0.element), classes($0.element)) })
  }
  guard value.hasPrefix(query), let raw = attr(field, kAXSelectedTextRangeAttribute),
    CFGetTypeID(raw) == AXValueGetTypeID()
  else { return false }
  var range = CFRange(location: 0, length: 0)
  return AXValueGetValue(raw as! AXValue, .cfRange, &range)
    && range.location == query.utf16.count && range.length > 0
    && range.length == value.utf16.count - query.utf16.count
}
func destinationChoices(_ root: AXUIElement, _ query: String) throws
  -> DestinationChoiceFailure
{
  let fields = try queryFields(root)
  let options = try pickerSuggestions(root)
  try require(
    fields.count == 1 && choiceQueryMatches(fields[0].element, query, options),
    "Query changed while collecting destination choices; Return withheld")
  let exactCount = try options.filter { try matchesDestination($0, query, .dm) }.count
  try require(
    exactCount != 1,
    "DM options changed before selection; Return withheld. Run read-dm again with the intended exact name or @handle"
  )
  var available: [(name: String, handles: [String])] = []
  for node in options {
    guard
      let name = dmSuggestionName(
        role(node.element), string(node.element, "AXDOMIdentifier"), label(node.element),
        classes(node.element))
    else { continue }
    available.append((name, try dmSuggestionHandles(node.element)))
  }
  let candidates: [[String: Any]] = available.prefix(20).map { candidate in
    let handle = candidate.handles.count == 1 ? candidate.handles.first : nil
    let unique =
      handle.map { value in available.filter { $0.handles.contains(value) }.count == 1 } ?? false
    let navigation: Any =
      unique
      ? ["command": "read-dm", "args": [handle!]] as [String: Any]
      : NSNull()
    return [
      "name": candidate.name, "handle": handle as Any? ?? NSNull(),
      "navigation": navigation,
    ]
  }
  return DestinationChoiceFailure(
    query: query, candidates: candidates,
    candidateCount: available.count, ambiguous: exactCount > 1 || available.count > 1,
    exactMatchCount: exactCount)
}
func dmFallbackEligible(_ error: Error, _ query: String, _ allowClipboard: Bool) -> Bool {
  guard let choices = error as? DestinationChoiceFailure else { return false }
  return allowClipboard && !choices.incomplete && choices.query == query
    && choices.exactMatchCount == 0
    && validDMSearchText(query) && query != "@"
}
func dmPersonMatches(_ kind: String, _ name: String, _ handle: String?, _ query: String) -> Bool {
  guard kind == "person", !name.isEmpty, validDMSearchText(query) else { return false }
  return query.hasPrefix("@") ? handle.map { "@\($0)" == query } == true : name == query
}
func resolveIndividualDM<T>(
  _ query: String, allowClipboard: Bool,
  primaryLookup: () throws -> T, directLookup: () throws -> T
) throws -> T {
  do { return try primaryLookup() } catch {
    guard dmFallbackEligible(error, query, allowClipboard) else { throw error }
  }
  return try directLookup()
}
// Slack exposes picker options as AXStaticText (ARIA option) or AXMenuItem
// (ARIA menuitem) depending on the client build; IDs and classes are unchanged.
func suggestionRole(_ value: String) -> Bool { value == "AXStaticText" || value == "AXMenuItem" }
func isSuggestion(_ node: Node) -> Bool {
  suggestionRole(role(node.element))
    && string(node.element, "AXDOMIdentifier").range(
      of: #"^c-search_autocomplete__suggestion_\d+$"#, options: .regularExpression) != nil
}
func dmSuggestionName(
  _ nodeRole: String, _ identifier: String, _ value: String, _ nodeClasses: [String]
) -> String? {
  guard suggestionRole(nodeRole),
    identifier.range(
      of: #"\Ac-search_autocomplete__suggestion_\d+\z"#, options: .regularExpression) != nil,
    !nodeClasses.contains(where: {
      $0.hasPrefix("c-search_autocomplete__suggestion_item--query")
        || $0.hasPrefix("c-search_autocomplete__suggestion_item--quick-message")
    }),
    let suffix = [", Direct Message", ", direct message"].first(where: value.hasSuffix)
  else { return nil }
  let name = String(value.dropLast(suffix.count))
  guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
  else { return nil }
  return name
}
func dmSuggestionHandles(_ element: AXUIElement) throws -> [String] {
  try tree(element).filter {
    role($0.element) == "AXStaticText"
      && label($0.element).range(of: #"\A@[^\s@]+\z"#, options: .regularExpression) != nil
      && label($0.element).count <= 500
      && !label($0.element).unicodeScalars.contains {
        CharacterSet.controlCharacters.contains($0)
      }
  }.map { label($0.element) }
}
// Slack's picker labels an app or agent DM "NAME (agent)" while the opened
// conversation's title and sidebar row show NAME. Only that observed label is
// accepted, and navigation still requires the exact NAME title and a D ID.
let dmAgentLabel = " (agent)"
func dmDestinationName(_ person: String) -> String {
  person.hasSuffix(dmAgentLabel) && person.count > dmAgentLabel.count
    ? String(person.dropLast(dmAgentLabel.count)) : person
}
func dmSuggestionMatches(_ name: String?, _ handles: [String], _ query: String) -> Bool {
  guard let name else { return false }
  return query.hasPrefix("@")
    ? handles.count == 1 && handles[0] == query
    : name == query || name == query + dmAgentLabel
}
func channelSuggestionMatches(_ name: String, _ query: String) -> Bool {
  // Parenthesized labels are observed metadata, not proof of destination kind.
  // Successful navigation still requires the exact channel title and a C/G URL.
  name == query || (name.hasPrefix("\(query) (") && name.hasSuffix(")"))
}
func conversationTitleMatches(_ title: String, _ name: String, _ kind: Destination) -> Bool {
  guard kind == .channel || kind == .dm else { return false }
  let prefix = "\(name) (\(kind == .dm ? "DM" : "Channel")) - "
  return title.hasPrefix(prefix) || title.hasPrefix("* \(prefix)")
    || title.hasPrefix("! \(prefix)")
}
func destinationMatches(_ title: String, _ identifier: String, _ name: String, _ kind: Destination)
  -> Bool
{
  guard kind == .channel || kind == .dm else { return false }
  let titleMatches = conversationTitleMatches(title, name, kind)
  let idPattern = kind == .dm ? #"^D[A-Z0-9]+$"# : #"^[CG][A-Z0-9]+$"#
  let idMatches =
    identifier.range(of: idPattern, options: .regularExpression)
    == identifier.startIndex..<identifier.endIndex
  return titleMatches && idMatches
}
func groupDestinationMatches(
  _ title: String, _ identifier: String, _ expectedIdentifier: String, _ name: String
) -> Bool {
  !name.isEmpty && identifier == expectedIdentifier
    && identifier.range(of: #"^[CG][A-Z0-9]+$"#, options: .regularExpression)
      == identifier.startIndex..<identifier.endIndex
    && conversationTitleMatches(title, name, .dm)
}
func pageDestinationMatches(_ title: String, _ identifier: String, _ target: [String: Any]) -> Bool
{
  guard let name = target["name"] as? String, let kind = target["kind"] as? String,
    kind == "dm" || kind == "channel"
  else { return false }
  if target["dmKind"] as? String == "group" {
    return kind == "dm" && target["conversationId"] as? String == identifier
      && target["requested"] as? String == "group:\(identifier)"
      && groupDestinationMatches(title, identifier, identifier, name)
  }
  return destinationMatches(title, identifier, name, kind == "dm" ? .dm : .channel)
}
func continuationDestinationName(
  _ title: String, _ identifier: String, _ boundary: String,
  _ operation: String, _ query: String
) -> String? {
  guard identifier == boundary, operation == "read-dm" || operation == "read-channel" else {
    return nil
  }
  let kind: Destination = operation == "read-dm" ? .dm : .channel
  let expected = kind == .channel && query.hasPrefix("#") ? String(query.dropFirst()) : query
  return destinationMatches(title, identifier, expected, kind) ? expected : nil
}
func mainListMatchesTitle(_ title: String, _ identifier: String, _ listLabel: String) -> Bool {
  guard let delimiter = title.range(of: #" \((Channel|DM)\) - "#, options: .regularExpression)
  else { return false }
  let literal = String(title[..<delimiter.lowerBound])
  guard !literal.isEmpty else { return false }
  let kind: Destination = title[delimiter].contains("(DM)") ? .dm : .channel
  let group = kind == .dm && !identifier.hasPrefix("D")
  let listKind = kind == .channel ? "channel" : group ? "group direct message" : "direct message"
  let decorated = literal.hasPrefix("* ") || literal.hasPrefix("! ")
  let candidates = [literal] + (decorated ? [String(literal.dropFirst(2))] : [])
  return candidates.contains { name in
    let verified =
      group
      ? groupDestinationMatches(title, identifier, identifier, name)
      : destinationMatches(title, identifier, name, kind)
    if kind == .channel {
      return verified && conversationListLabelMatches(listLabel, name, ["kind": "channel"])
    }
    let prefix = "\(name) (\(listKind)"
    return verified && (listLabel == "\(prefix))" || listLabel.hasPrefix("\(prefix),"))
  }
}
func groupLookupNavigation(_ names: [String]) -> Bool {
  !names.contains {
    $0.hasPrefix("c-search_autocomplete__suggestion_item--query")
      || $0.hasPrefix("c-search_autocomplete__suggestion_item--quick-message")
  }
}
func groupLookupSuggestionMatches(
  _ candidateRole: String, _ candidateID: String, _ name: String, _ names: [String],
  _ markerCount: Int, _ enabled: Bool, _ navigationCount: Int = 1
) -> Bool {
  navigationCount == 1 && suggestionRole(candidateRole) && enabled && !name.isEmpty
    && name.count <= 500
    && candidateID.range(
      of: #"^c-search_autocomplete__suggestion_[0-9]+$"#,
      options: .regularExpression) == candidateID.startIndex..<candidateID.endIndex
    && names.contains("c-search_autocomplete__suggestion_item")
    && groupLookupNavigation(names) && markerCount == 1
}
func groupLookupSelectionMatches(
  _ expected: String, _ observed: String?, _ count: Int, _ sameElement: Bool
) -> Bool {
  !expected.isEmpty && count == 1 && observed == expected && sameElement
}
func groupLookupInitialUpMatches<T: Hashable>(
  _ expectedOptions: [T], _ observedOptions: [T], candidate: T, selected: [Bool?],
  retainedField: Bool, queryFocused: Bool, focusedCount: Int
) -> Bool {
  !expectedOptions.isEmpty && expectedOptions.count <= 200 && expectedOptions == observedOptions
    && Set(expectedOptions).count == expectedOptions.count && expectedOptions.last == candidate
    && selected.count == expectedOptions.count && selected.allSatisfy { $0 == false }
    && retainedField && queryFocused && focusedCount == 1
}
func groupLookupMatch(_ node: Node, _ count: Int) throws -> Bool {
  let markers = try tree(node.element).filter {
    role($0.element) == "AXGroup"
      && classes($0.element).contains("c-small_mpim_entity__mpim_counter--updated")
  }
  return groupLookupSuggestionMatches(
    role(node.element), string(node.element, "AXDOMIdentifier"),
    label(node.element), classes(node.element), markers.count,
    (attr(node.element, kAXEnabledAttribute) as? Bool) == true, count)
}
func exactGroupLookupQueryOption(_ name: String, _ names: [String], _ identifier: String) -> Bool {
  name == "Search for: \(identifier)"
    && names.contains("c-search_autocomplete__suggestion_item--query")
    && !names.contains { $0.hasPrefix("c-search_autocomplete__suggestion_item--quick-message") }
}
func requireGroupLookupBudget(_ deadline: Date?, now: Date = Date()) throws {
  try require(
    deadline == nil || now < deadline!,
    "Background navigation reached its input deadline; no further input posted. Inspect before retrying"
  )
}
func groupSidebarAbsent(_ rowCount: Int, _ dmKind: String?) throws -> Bool {
  if rowCount == 0 {
    try require(dmKind == nil, "Group sidebar identity is inconsistent; lookup withheld")
    return true
  }
  try require(
    rowCount == 1 && dmKind == "group",
    "Sidebar ID is present but not one verified group DM; lookup and input withheld")
  return false
}
func groupTarget(_ identifier: String, _ name: String, _ url: URL) -> [String: Any] {
  [
    "kind": "dm", "dmKind": "group", "conversationId": identifier, "name": name,
    "requested": "group:\(identifier)", "handle": NSNull(), "url": url.absoluteString,
  ]
}
func currentGroupName(_ title: String, _ identifier: String, _ expectedIdentifier: String)
  -> String?
{
  guard let delimiter = title.range(of: " (DM) - ") else { return nil }
  let name = String(title[..<delimiter.lowerBound])
  return groupDestinationMatches(title, identifier, expectedIdentifier, name) ? name : nil
}
func currentGroupCandidates(_ title: String, _ identifier: String, _ expectedIdentifier: String)
  -> [String]
{
  guard let literal = currentGroupName(title, identifier, expectedIdentifier) else { return [] }
  var candidates = [literal]
  if literal.hasPrefix("* ") || literal.hasPrefix("! ") {
    let alternate = String(literal.dropFirst(2))
    if groupDestinationMatches(title, identifier, expectedIdentifier, alternate) {
      candidates.append(alternate)
    }
  }
  return candidates
}
func corroboratedGroupName(_ candidates: [String], matches: (String) throws -> Bool) throws
  -> String?
{
  let verified = try candidates.filter(matches)
  try require(verified.count <= 1, "Current group DM name is ambiguous; input withheld")
  return verified.first
}
func currentGroupTarget(_ root: AXUIElement, _ identifier: String) throws -> [String: Any]? {
  guard try queryFields(root).isEmpty, let url = attr(root, kAXURLAttribute) as? URL else {
    return nil
  }
  let candidates = currentGroupCandidates(label(root), url.lastPathComponent, identifier)
  guard
    let name = try corroboratedGroupName(
      candidates,
      matches: {
        try messagesReady(root, groupTarget(identifier, $0, url))
      })
  else { return nil }
  return groupTarget(identifier, name, url)
}
func conversationListKind(_ target: [String: Any]) -> String {
  target["kind"] as? String == "dm"
    ? (target["dmKind"] as? String == "group" ? "group direct message" : "direct message")
    : "channel"
}
func conversationListLabelMatches(_ value: String, _ name: String, _ target: [String: Any]) -> Bool
{
  guard !name.isEmpty, let kind = target["kind"] as? String, ["channel", "dm"].contains(kind)
  else { return false }
  // A Slack Connect channel labels its list "NAME (shared channel)"; the JS
  // layer and source-list checks already accept it.
  let kinds =
    kind == "channel"
    ? ["channel", "private channel", "shared channel"] : [conversationListKind(target)]
  return kinds.contains { listKind in
    let prefix = "\(name) (\(listKind)"
    return value == "\(prefix))" || value.hasPrefix("\(prefix),")
  }
}
func canonicalChannelSearch(_ query: String) -> String {
  var result = ""
  var token = ""
  var quote: Character? = nil
  var escaped = false
  func flush() {
    if token.range(of: #"\Ain:#[A-Za-z0-9_-]+\z"#, options: .regularExpression) != nil {
      result += "in:" + token.dropFirst(4)
    } else {
      result += token
    }
    token = ""
  }
  for character in query {
    if character.isWhitespace && quote == nil && !escaped {
      flush()
      result.append(character)
      continue
    }
    token.append(character)
    if escaped {
      escaped = false
    } else if character == "\\" {
      escaped = true
    } else if quote == character {
      quote = nil
    } else if quote == nil && (character == "\"" || character == "'") {
      quote = character
    }
  }
  flush()
  return result
}
func searchPickerQueryLabel(_ query: String) -> String {
  // Encode the requested text once. Decoding the observed label would alias
  // literal entity text (for example &quot;) with a different quoted query.
  var encoded = "Search for: "
  for character in query.unicodeScalars {
    switch character {
    case "&": encoded += "&amp;"
    case "<": encoded += "&lt;"
    case ">": encoded += "&gt;"
    case "\"": encoded += "&quot;"
    case "'": encoded += "&#39;"
    default: encoded.unicodeScalars.append(character)
    }
  }
  return encoded
}
func encodedSearchQueryOption(
  _ role: String, _ id: String, _ name: String, _ names: [String], _ query: String
) -> Bool {
  let expected = searchPickerQueryLabel(query)
  let required = [
    "c-search_autocomplete__suggestion_item",
    "c-search_autocomplete__suggestion_item--query",
    "c-search_autocomplete__suggestion_item--query--icon-standalone",
    "c-search_autocomplete__suggestion_item_left_aligned",
  ]
  return expected != "Search for: \(query)" && name == expected && suggestionRole(role)
    && id.range(
      of: #"^c-search_autocomplete__suggestion_(0|[1-9][0-9]*)$"#,
      options: .regularExpression) == id.startIndex..<id.endIndex
    && (names.sorted() == required.sorted()
      || names.sorted()
        == (required + ["c-search_autocomplete__suggestion_item--pseudo-selected"]).sorted()
      || names.sorted()
        == (required + ["c-search_autocomplete__suggestion_item--selected"]).sorted())
}
func encodedSearchQueryValue(
  _ value: String, _ query: String, queryOptionCount: Int, expectedOptionCount: Int,
  expectedPseudoSelected: Bool, expectedSelected: Bool
) -> Bool {
  guard !query.isEmpty, searchPickerQueryLabel(query) != "Search for: \(query)",
    queryOptionCount == 1, expectedOptionCount == 1
  else { return false }
  return value == query
    || (value == "\(query) — Search" && (expectedPseudoSelected || expectedSelected))
}
func matchesDestination(_ node: Node, _ query: String, _ kind: Destination) throws -> Bool {
  guard isSuggestion(node) else { return false }
  if kind != .search
    && classes(node.element).contains(where: {
      $0.hasPrefix("c-search_autocomplete__suggestion_item--query")
        || $0.hasPrefix("c-search_autocomplete__suggestion_item--quick-message")
    })
  {
    return false
  }
  let name = label(node.element)
  switch kind {
  case .search:
    if searchPickerQueryLabel(query) == "Search for: \(query)" {
      return classes(node.element).contains("c-search_autocomplete__suggestion_item--query")
        && canonicalChannelSearch(name) == "Search for: \(canonicalChannelSearch(query))"
    }
    return encodedSearchQueryOption(
      role(node.element), string(node.element, "AXDOMIdentifier"), name, classes(node.element),
      query)
  case .channel:
    return channelSuggestionMatches(name, query)
  case .group:
    return try groupLookupMatch(node, 1)
  case .dm:
    let person = dmSuggestionName(
      role(node.element), string(node.element, "AXDOMIdentifier"), name, classes(node.element))
    return try dmSuggestionMatches(
      person, query.hasPrefix("@") ? dmSuggestionHandles(node.element) : [], query)
  }
}
// A Search picker left open covers the rest of Slack's accessibility tree, so
// every later command fails. When a picker-driven command stops with the picker
// still open, close it once with a targeted Escape. Escape never submits a query.
func closeLeftoverPicker(_ workspace: Workspace, _ pid: pid_t) {
  guard let root = try? workspace.root(), let fields = try? queryFields(root), !fields.isEmpty,
    let id = try? windowId(workspace.window, pid)
  else { return }
  do {
    try backgroundKey(53, "\u{1B}", root, workspace.window, id, pid)
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
      settle()
      if let fresh = try? workspace.root(), (try? queryFields(fresh))?.isEmpty == true {
        recoverySteps.append("Closed the Search picker left open by the stopped command")
        return
      }
    }
    recoverySteps.append("Search picker may still be open after the stopped command")
  } catch {
    recoverySteps.append("Search picker could not be closed after the stopped command")
  }
}
func search(
  _ query: String, _ workspace: Workspace, _ running: NSRunningApplication,
  kind: Destination = .search, inputDeadline: Date? = nil, resultQuery: String? = nil
) throws -> [String: Any] {
  do {
    return try searchOrNavigate(
      query, workspace, running, kind: kind, inputDeadline: inputDeadline,
      resultQuery: resultQuery)
  } catch {
    closeLeftoverPicker(workspace, running.processIdentifier)
    throw error
  }
}
func searchOrNavigate(
  _ query: String, _ workspace: Workspace, _ running: NSRunningApplication,
  kind: Destination, inputDeadline: Date?, resultQuery: String?
) throws -> [String: Any] {
  let groupDeadline =
    kind == .group
    ? min(Date().addingTimeInterval(12), inputDeadline ?? .distantFuture) : inputDeadline
  if kind == .group {
    try require(try groupDMIdentifier("group:\(query)") == query, "Invalid group lookup ID")
  }
  try require(
    !query.isEmpty && query.count <= 500
      && !query.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) },
    "Destination must be 1–500 characters without control characters")
  if kind == .channel {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    try require(
      query.count <= 80 && query.unicodeScalars.allSatisfy { allowed.contains($0) },
      "Channel name must be an exact name using letters, numbers, hyphens or underscores, optionally prefixed by #; no input posted"
    )
  }
  var root = try workspace.root()
  if kind == .search, try queryFields(root).isEmpty,
    let url = attr(root, kAXURLAttribute) as? URL, url.lastPathComponent == "search"
  {
    let queries = try tree(root).filter {
      role($0.element) == "AXButton" && label($0.element).hasPrefix("Search: ")
    }
    if queries.count == 1,
      canonicalChannelSearch(label(queries[0].element))
        == "Search: \(canonicalChannelSearch(resultQuery ?? query))"
    {
      _ = try firstSearchPage(workspace, resultQuery ?? query, inputDeadline: groupDeadline)
      recoverySteps.append("Reused independently verified results for the requested search")
      return [:]
    }
  }
  if kind == .dm || kind == .group {
    let identifier = (attr(root, kAXURLAttribute) as? URL)?.lastPathComponent ?? ""
    // The DMs hub can open a person while keeping /dms as its URL. Return
    // through Home before selecting a DM so its conversation ID is exposed.
    if identifier.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression) == nil {
      try ensureSidebar(workspace, running)
      root = try workspace.root()
      recoverySteps.append("Normalized DM navigation through Home")
    }
  }
  if kind == .channel, try queryFields(root).isEmpty,
    let url = attr(root, kAXURLAttribute) as? URL,
    destinationMatches(label(root), url.lastPathComponent, query, kind)
  {
    recoverySteps.append("Requested channel already open; reused current view")
    return [
      "kind": "channel", "name": query, "requested": query, "handle": NSNull(),
      "url": url.absoluteString,
    ]
  }
  let window = workspace.window
  let id = try windowId(window, running.processIdentifier)
  if try queryFields(root).isEmpty {
    try requireNoModal(workspace.window)
    let buttons = try tree(root).filter(searchButton)
    try require(buttons.count == 1, "Search button ambiguous")
    try sampleDesktop("before-open-search")
    try requireGroupLookupBudget(groupDeadline)
    _ = try activate(
      buttons[0].element, workspace, window: id, what: "Search", inputDeadline: groupDeadline
    ) { try !queryFields(workspace.root()).isEmpty }
    // Inspect readiness immediately; only an absent picker needs a polling wait.
    root = try workspace.root()
    let deadline = min(Date().addingTimeInterval(12), groupDeadline ?? .distantFuture)
    while try queryFields(root).isEmpty && Date() < deadline {
      settle(0.01)
      root = try workspace.root()
      try sampleDesktop("wait-search")
    }
    try sampleDesktop("after-open-search")
  }
  let fields = try queryFields(root)
  try require(
    fields.count == 1,
    "Search did not expose one Query field before the deadline; opening may still complete, but no query was submitted"
  )
  try sampleDesktop("before-query-value")
  try requireNoModal(workspace.window)
  try requireQueryFocus(root)
  if kind == .group {
    try require(
      try windowId(window, running.processIdentifier) == id,
      "Slack window changed before group lookup; input withheld")
  }
  try requireGroupLookupBudget(groupDeadline)
  try require(
    try interactionAXValue(
      fields[0].element, kAXValueAttribute as CFString, query as CFString) == .success,
    "Search field refused value")
  root = try workspace.root()
  let retainedGroupQueryField = fields[0].element
  var diagnosticRetainedGroup: AXUIElement?
  var retainedGroupQueryOption: AXUIElement?
  func captureGroupPickerFailure(_ fields: [Node], _ options: [Node], allowPending: Bool) {
    guard firstGroupPickerRejection == nil else { return }
    firstGroupPickerRejection = groupPickerFailureDiagnostic(
      query,
      fields: fields.prefix(2).map { node in
        let values = liveAttrs(
          node.element,
          [
            kAXValueAttribute, kAXSelectedTextRangeAttribute,
            kAXSelectedTextRangesAttribute, kAXFocusedAttribute,
          ])
        return GroupPickerFieldState(
          value: values[0] as? String, range: groupPickerRange(values[1]),
          ranges: (values[2] as? [AnyObject]).map { $0.map { groupPickerRange($0) } },
          focused: values[3] as? Bool,
          matchesRetained: CFEqual(node.element, retainedGroupQueryField))
      },
      options: options.prefix(20).map { node in
        let names = classes(node.element)
        let actionInventory = readGroupPickerActions(node.element)
        return GroupPickerOptionState(
          role: role(node.element), label: label(node.element), classes: names,
          selected: attr(node.element, kAXSelectedAttribute) as? Bool,
          matchesRetained: diagnosticRetainedGroup.map { CFEqual($0, node.element) },
          exactQueryOption: exactGroupLookupQueryOption(label(node.element), names, query),
          hasPress: actionInventory.names.map { $0.contains("AXPress") },
          hasShowMenu: actionInventory.names.map { $0.contains("AXShowMenu") },
          actionReadStatus: actionInventory.status.rawValue,
          matchesRetainedQueryOption: retainedGroupQueryOption.map { CFEqual($0, node.element) })
      }, retainedCandidate: diagnosticRetainedGroup != nil, allowPending: allowPending,
      fieldCount: fields.count, optionCount: options.count)
  }
  func candidates(allowPending: Bool = false) throws -> [Node] {
    let options = try pickerSuggestions(root)
    if kind == .group {
      let fields = try queryFields(root)
      let queryMatches = fields.count == 1 && choiceQueryMatches(fields[0].element, query, options)
      if !queryMatches { captureGroupPickerFailure(fields, options, allowPending: allowPending) }
      try require(
        queryMatches,
        "Exact group-ID query changed; Return withheld")
      let queryOptions = options.filter {
        exactGroupLookupQueryOption(label($0.element), classes($0.element), query)
      }
      if allowPending && queryOptions.isEmpty { return [] }
      try require(queryOptions.count == 1, "Exact group-ID query option changed; Return withheld")
      // ID lookup is a query-bound navigation option, not a candidate exposing
      // its own ID. Refuse mixed/ambiguous options, then verify the final ID.
      let navigation = options.filter { groupLookupNavigation(classes($0.element)) }
      guard let candidate = navigation.first else { return [] }
      return try groupLookupMatch(candidate, navigation.count) ? [candidate] : []
    }
    let matches = try options.filter { try matchesDestination($0, query, kind) }
    if kind == .search && searchPickerQueryLabel(query) != "Search for: \(query)" {
      let queryOptions = options.filter {
        classes($0.element).contains {
          $0.hasPrefix("c-search_autocomplete__suggestion_item--query")
        }
      }
      if allowPending && queryOptions.isEmpty { return [] }
      let fields = try queryFields(root)
      let expected = matches.first?.element
      try require(
        fields.count == 1
          && encodedSearchQueryValue(
            string(fields[0].element, kAXValueAttribute), query,
            queryOptionCount: queryOptions.count, expectedOptionCount: matches.count,
            expectedPseudoSelected: expected.map {
              classes($0).contains("c-search_autocomplete__suggestion_item--pseudo-selected")
            } ?? false,
            expectedSelected: expected.map { (attr($0, kAXSelectedAttribute) as? Bool) == true }
              ?? false),
        "Exact encoded search query or option changed; Return withheld")
    }
    return matches
  }
  var destinations = try candidates(allowPending: true)
  let suggestionDeadline = min(Date().addingTimeInterval(4), groupDeadline ?? .distantFuture)
  while destinations.isEmpty && Date() < suggestionDeadline {
    settle(0.01)
    root = try workspace.root()
    try sampleDesktop("wait-suggestions")
    destinations = try candidates(allowPending: true)
  }
  if destinations.count != 1 && kind == .dm {
    root = try workspace.root()
    throw try destinationChoices(root, query)
  }
  try require(
    destinations.count == 1,
    kind == .group
      ? "Exact-ID group lookup did not expose one supported group option; Return withheld. Check the reference and current workspace"
      : "Exact destination option unavailable or ambiguous; Return withheld. For duplicate DM names use an exact @handle exposed by inspect"
  )
  let expected = label(destinations[0].element)
  let name: String
  if kind == .dm {
    guard
      let person = dmSuggestionName(
        role(destinations[0].element), string(destinations[0].element, "AXDOMIdentifier"),
        expected, classes(destinations[0].element))
    else { throw Failure(description: "Exact DM destination changed; Return withheld") }
    name = dmDestinationName(person)
  } else {
    name = kind == .group ? expected : query
  }
  let pinnedGroup = kind == .group ? destinations[0].element : nil
  diagnosticRetainedGroup = pinnedGroup
  var groupUpSent = false
  if let pinnedGroup {
    settle()
    root = try workspace.root()
    let stable = try candidates()
    try require(
      groupLookupSelectionMatches(
        name, stable.first.map { label($0.element) }, stable.count,
        stable.first.map { CFEqual($0.element, pinnedGroup) } ?? false),
      "Group lookup candidate changed while settling; Return withheld")
    let initialNodes = try pickerSuggestions(root)
    let initialOptions = initialNodes.map { AXIdentity(element: $0.element) }
    let initialQueryOptions = initialNodes.filter {
      exactGroupLookupQueryOption(label($0.element), classes($0.element), query)
    }
    try require(
      initialQueryOptions.count == 1, "Original group query option changed; input withheld")
    retainedGroupQueryOption = initialQueryOptions[0].element
    func canSelectLastGroup(_ options: [AXIdentity], _ root: AXUIElement) throws -> Bool {
      let fields = try queryFields(root)
      let focused = try focusedNodes(root)
      return groupLookupInitialUpMatches(
        initialOptions, options, candidate: AXIdentity(element: pinnedGroup),
        selected: options.map { liveAttr($0.element, kAXSelectedAttribute) as? Bool },
        retainedField: fields.count == 1 && CFEqual(fields[0].element, retainedGroupQueryField),
        queryFocused: focused.count == 1 && CFEqual(focused[0].element, retainedGroupQueryField)
          && liveAttr(retainedGroupQueryField, kAXFocusedAttribute) as? Bool == true,
        focusedCount: focused.count)
    }
    if try canSelectLastGroup(initialOptions, root) {
      try finalWindowInput(
        id, currentWindow: { try windowId(window, running.processIdentifier) },
        noModal: { try requireNoModal(workspace.window) },
        verifyControl: {
          root = try workspace.root()
          let fresh = try candidates()
          try require(
            groupLookupSelectionMatches(
              expected, fresh.first.map { label($0.element) }, fresh.count,
              fresh.first.map { CFEqual($0.element, pinnedGroup) } ?? false),
            "Group lookup candidate changed before Up; input withheld")
          try require(
            try canSelectLastGroup(
              try pickerSuggestions(root).map { AXIdentity(element: $0.element) }, root),
            "Group lookup option order, selection or Query focus changed; Up withheld")
        },
        input: {
          try requireGroupLookupBudget(groupDeadline)
          groupUpSent = true
          try backgroundKey(
            126, "\u{F700}", root, window, id, running.processIdentifier,
            inputDeadline: groupDeadline)
          recoverySteps.append("Sent one verified Up toward the last exact-ID group suggestion")
        })
    }
  }
  var selected = false
  for _ in 0..<12 {
    root = try workspace.root()
    let choices = try candidates()
    try require(
      choices.count == 1 && label(choices[0].element) == expected
        && (pinnedGroup == nil
          || groupLookupSelectionMatches(
            expected, label(choices[0].element), choices.count,
            CFEqual(choices[0].element, pinnedGroup!))),
      "Exact destination changed; Return withheld")
    let active = try pickerSuggestions(root).filter {
      (attr($0.element, kAXSelectedAttribute) as? Bool) == true
    }
    if active.count == 1 && CFEqual(active[0].element, choices[0].element) {
      selected = true
      break
    }
    if groupUpSent {
      captureGroupPickerFailure(
        try queryFields(root), try pickerSuggestions(root), allowPending: false)
    }
    try require(
      !groupUpSent, "The single group Up did not select the retained candidate; Return withheld")
    try requireGroupLookupBudget(groupDeadline)
    try backgroundKey(
      125, "\u{F701}", root, window, id, running.processIdentifier, inputDeadline: groupDeadline)
  }
  try require(selected, "Exact search option could not be selected; Return withheld")
  root = try workspace.root()
  let selectedNow = try pickerSuggestions(root).filter {
    (attr($0.element, kAXSelectedAttribute) as? Bool) == true
  }
  let choicesNow = try candidates()
  try require(
    selectedNow.count == 1 && choicesNow.count == 1
      && CFEqual(selectedNow[0].element, choicesNow[0].element)
      && label(selectedNow[0].element) == expected
      && (pinnedGroup == nil
        || groupLookupSelectionMatches(
          expected, label(choicesNow[0].element), choicesNow.count,
          CFEqual(choicesNow[0].element, pinnedGroup!))),
    "Selection changed; Return withheld")
  try requireGroupLookupBudget(groupDeadline)
  try backgroundKey(
    36, "\r", root, window, id, running.processIdentifier,
    expectedSuggestion: choicesNow[0].element,
    inputDeadline: groupDeadline,
    waitForCompletion: kind != .search
  )
  let deadline = min(Date().addingTimeInterval(8), groupDeadline ?? .distantFuture)
  while Date() < deadline {
    try sampleDesktop("verify-results")
    root = try workspace.root()
    let nodes = try tree(root)
    let overlayClosed = try queryFields(root).isEmpty
    let url = attr(root, kAXURLAttribute) as? URL
    let identifier = url?.lastPathComponent ?? ""
    if kind == .group && overlayClosed, let url,
      groupDestinationMatches(label(root), identifier, query, name)
    {
      let target = groupTarget(query, name, url)
      if try messagesReady(root, target) {
        recoverySteps.append("Resolved requested group DM through exact-ID Search lookup")
        return target
      }
    }
    if kind != .search && kind != .group && overlayClosed {
      if destinationMatches(label(root), identifier, name, kind) {
        return [
          "kind": kind == .dm ? "dm" : "channel", "name": name, "requested": query,
          "handle": kind == .dm && query.hasPrefix("@") ? query as Any : NSNull(),
          "url": url!.absoluteString,
        ]
      }
    }
    let queryMatches = nodes.contains {
      role($0.element) == "AXButton"
        && canonicalChannelSearch(label($0.element))
          == "Search: \(canonicalChannelSearch(resultQuery ?? query))"
    }
    let resultVisible = nodes.contains {
      role($0.element) == "AXList" && label($0.element).hasPrefix("Message results,")
    }
    let emptyContainers = nodes.filter { classes($0.element).contains("c-empty_state") }
    var emptyResults = false
    if !resultVisible && emptyContainers.count == 1 && url?.lastPathComponent == "search" {
      let labels = try tree(emptyContainers[0].element).filter {
        role($0.element) == "AXStaticText"
      }.map { label($0.element) }
      emptyResults = searchEmptyLabelsMatch(labels)
    }
    if kind == .search && queryMatches && (resultVisible || emptyResults) && overlayClosed {
      return [:]
    }
    settle(0.01)
  }
  throw Failure(
    description:
      "Submission attempted once, but destination not verified before deadline; inspect without resubmitting"
  )
}
// MARK: Directory listing (browse-channels / browse-people)

func directoryViewMatches(_ nodeRole: String, _ name: String, _ names: [String]) -> Bool {
  nodeRole == "AXGroup" && names.contains("p-view_contents--primary")
    && ["Unified directory", "Unified Directory"].contains(name)
}
func directoryTabsMatch(_ nodeRole: String, _ name: String, _ names: [String]) -> Bool {
  nodeRole == "AXTabGroup" && names.contains("c-tabs__tab_menu")
    && ["Unified directory tabs", "Unified Directory Tabs"].contains(name)
}
// "89 members" → 89. Nil for any other text.
func directoryMemberCount(_ text: String) -> Int? {
  guard
    let match = text.range(of: #"\A([0-9][0-9,]{0,9}) members?\z"#, options: .regularExpression)
  else { return nil }
  return Int(text[match].filter { $0.isNumber })
}
func directoryChannelRowMatches(_ nodeRole: String, _ id: String, _ names: [String]) -> Bool {
  nodeRole == "AXGroup"
    && id.range(of: #"\A[CG][A-Z0-9]{2,30}\z"#, options: .regularExpression) != nil
    && names.contains("p-explorer_results__contained-result")
}
func directoryPersonInfoID(_ id: String) -> String? {
  guard
    id.range(of: #"\Abrowse_page_member_info_[UW][A-Z0-9]{2,30}\z"#, options: .regularExpression)
      != nil
  else { return nil }
  return String(id.dropFirst("browse_page_member_info_".count))
}
func directoryTexts(_ element: AXUIElement, skipping skip: (AXUIElement) -> Bool) -> [String] {
  var texts: [String] = []
  func visit(_ node: AXUIElement, _ depth: Int) {
    guard depth < 12, !skip(node) else { return }
    if role(node) == "AXStaticText" {
      let text = (scalarValue(node) ?? label(node)).trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty { texts.append(text) }
    }
    for child in accessibilityChildren(node) { visit(child, depth + 1) }
  }
  visit(element, 0)
  return texts
}
// Rows exposed in the active directory tab. Channels come from the channel
// result list; people from the member-card grid.
func directoryRecords(_ panel: AXUIElement, _ tab: String) throws -> [[String: Any]] {
  var records: [[String: Any]] = []
  if tab == "channels" {
    let lists = try tree(panel).filter {
      role($0.element) == "AXList" && label($0.element) == "Channel results"
    }
    try require(lists.count == 1, "Channel directory list is unavailable or ambiguous")
    for row in accessibilityChildren(lists[0].element) {
      let id = string(row, "AXDOMIdentifier")
      guard directoryChannelRowMatches(role(row), id, classes(row)) else { continue }
      let nodes = try tree(row)
      // Joined channels expose the name as a channel link; others as text.
      let link = nodes.first {
        role($0.element) == "AXLink" && classes($0.element).contains("c-mrkdwn__channel")
      }.map { label($0.element) }
      let joinButtons = nodes.filter {
        role($0.element) == "AXButton" && label($0.element) == "Join"
      }
      let texts = directoryTexts(row) { node in
        classes(node).contains("c-channel_search_result__actions")
          || classes(node).contains("c-medium_channel_entity__channel_suffix")
          || role(node) == "AXLink" || role(node) == "AXButton"
      }
      let memberIndex = texts.firstIndex { directoryMemberCount($0) != nil }
      var name = link.map { $0.hasPrefix("#") ? String($0.dropFirst()) : $0 }
      if name == nil, let first = texts.first, directoryMemberCount(first) == nil {
        name = first
      }
      guard let name, !name.isEmpty else {
        throw Failure(description: "Channel directory row has no exposed name")
      }
      var record: [String: Any] = [
        "id": id, "name": name, "joined": joinButtons.isEmpty,
      ]
      if let memberIndex {
        record["memberCount"] = directoryMemberCount(texts[memberIndex])!
        let rest = texts[(memberIndex + 1)...].filter { $0 != "·" }
        if !rest.isEmpty { record["description"] = rest.joined(separator: " ") }
      }
      records.append(record)
    }
  } else {
    for node in try tree(panel) {
      guard let id = directoryPersonInfoID(string(node.element, "AXDOMIdentifier")) else {
        continue
      }
      let texts = directoryTexts(node.element) { _ in false }
      guard let name = texts.first else {
        throw Failure(description: "People directory card has no exposed name")
      }
      var record: [String: Any] = ["id": id, "name": name]
      let rest = Array(texts.dropFirst())
      if !rest.isEmpty { record["title"] = rest.joined(separator: " · ") }
      records.append(record)
    }
  }
  return records
}
// Opens Directories from the Home sidebar, selects the requested tab, and
// collects its exposed rows with bounded scrolling. Read-only: no Join, no
// profile or channel is opened.
func browseDirectory(
  _ tab: String, _ workspace: Workspace, _ running: NSRunningApplication, _ requestedPages: Int
) throws -> [String: Any] {
  var opened = false
  var records: [[String: Any]] = []
  var seen = Set<String>()
  var steps = 0
  var stopReason = "page-limit"
  do {
    try ensureSidebar(workspace, running)
    func directoryView() throws -> AXUIElement? {
      let views = try tree(workspace.root()).filter {
        directoryViewMatches(role($0.element), label($0.element), classes($0.element))
      }
      try require(views.count <= 1, "Directory view is ambiguous")
      return views.first?.element
    }
    if try directoryView() == nil {
      let rows = try tree(workspace.root()).filter {
        role($0.element) == "AXRow" && string($0.element, "AXDOMIdentifier") == "unified_directory"
      }
      try require(rows.count == 1, "Directories entry is unavailable in the sidebar")
      // The row itself only selects; its page link opens the directory.
      let links = accessibilityChildren(rows[0].element).filter {
        classes($0).contains("p-channel_sidebar__link--page")
          && actions($0).contains(kAXPressAction)
      }
      try require(links.count == 1, "Directories link is unavailable or ambiguous")
      let window = try windowId(workspace.window, workspace.pid)
      try requireNoModal(workspace.window)
      try sampleDesktop("before-open-directory")
      try finalWindowInput(
        window, currentWindow: { try windowId(workspace.window, workspace.pid) },
        noModal: { try requireNoModal(workspace.window) },
        input: {
          opened = true
          try press(links[0])
        })
    }
    var view: AXUIElement?
    let openDeadline = Date().addingTimeInterval(6)
    repeat {
      settle()
      try sampleDesktop("wait-directory")
      view = try directoryView()
    } while view == nil && Date() < openDeadline
    guard let view else { throw Failure(description: "Directory view did not open") }
    let tabs = try tree(view).filter {
      role($0.element) == "AXRadioButton" && string($0.element, "AXDOMIdentifier") == tab
        && ancestor(
          $0.element,
          matching: { directoryTabsMatch(role($0), label($0), classes($0)) })
          != nil
    }
    try require(tabs.count == 1, "Directory \(tab) tab is unavailable or ambiguous")
    let panelLabel = tab == "channels" ? "Channels" : "People"
    func panel() throws -> AXUIElement? {
      try tree(view).first {
        classes($0.element).contains(where: { $0.hasPrefix("unifiedDirectoryTabsPanel") })
          && label($0.element) == panelLabel
      }?.element
    }
    if try panel() == nil {
      try press(tabs[0].element)
    }
    var active: AXUIElement?
    let tabDeadline = Date().addingTimeInterval(6)
    repeat {
      settle()
      active = try panel()
      if let active, !(try directoryRecords(active, tab)).isEmpty { break }
    } while Date() < tabDeadline
    guard let active else { throw Failure(description: "Directory \(tab) tab did not load") }
    let maxSteps = requestedPages * 5
    let deadline = Date().addingTimeInterval(80)
    var idle = 0
    while Date() < deadline {
      let current = try directoryRecords(active, tab)
      var added = 0
      for record in current {
        guard let id = record["id"] as? String, seen.insert(id).inserted else { continue }
        records.append(record)
        added += 1
      }
      idle = added == 0 ? idle + 1 : 0
      // Two captures in a row with nothing new. Slack's directory stops loading
      // after its first batch (about 50 results) under accessibility scrolling,
      // so this is not proof that the directory has no more entries.
      if idle >= 2 {
        stopReason = "no-progress"
        break
      }
      if steps >= maxSteps { break }
      // Scroll the last exposed result into view to load the next batch.
      let edges = try tree(active).filter {
        if tab == "channels" {
          return directoryChannelRowMatches(
            role($0.element), string($0.element, "AXDOMIdentifier"), classes($0.element))
        }
        return role($0.element) == "AXRow" && classes($0.element).contains("p-grid__row")
      }
      guard let edge = edges.last?.element, actions(edge).contains("AXScrollToVisible") else {
        stopReason = "no-scroll"
        break
      }
      _ = try interactionAXAction(edge, "AXScrollToVisible" as CFString)
      steps += 1
      settle()
    }
    if Date() >= deadline { stopReason = "time-limit" }
  } catch {
    return [
      "operation": "browse-\(tab)", "status": "stopped", "error": String(describing: error),
      "directoryOpened": opened, "pid": workspace.pid, "records": records,
      "next": "Inspect the current Slack view before another request; no input is replayed.",
      "recovery": recoverySteps,
    ]
  }
  let url = (try? workspace.root()).flatMap { attr($0, kAXURLAttribute) as? URL }
  return [
    "operation": "browse-\(tab)", "status": "ok", "pid": workspace.pid,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "url": url?.absoluteString as Any? ?? NSNull(),
    "records": records, "scrollSteps": steps, "stopReason": stopReason,
    "directoryOpened": opened, "recovery": recoverySteps,
  ]
}
func ensureSidebar(
  _ workspace: Workspace, _ running: NSRunningApplication, inputDeadline: Date? = nil
) throws {
  var root = try workspace.root()
  if try !queryFields(root).isEmpty {
    let id = try windowId(workspace.window, running.processIdentifier)
    try backgroundKey(
      53, "\u{1B}", root, workspace.window, id, running.processIdentifier,
      inputDeadline: inputDeadline)
    root = try workspace.root()
    try require(try queryFields(root).isEmpty, "Query overlay remains open; cannot read channels")
    recoverySteps.append("Closed existing Search picker")
  }
  func sidebars() throws -> [Node] {
    try tree(root).filter {
      role($0.element) == "AXOutline" && label($0.element) == "Channels and direct messages"
    }
  }
  if try sidebars().isEmpty {
    _ = try windowId(workspace.window, running.processIdentifier)
    try requireNoModal(workspace.window)
    func isHome(_ node: Node) -> Bool {
      role(node.element) == "AXRadioButton" && string(node.element, "AXDOMIdentifier") == "home"
        && label(node.element) == "Home"
    }
    try prepareAccessibility(workspace.app, control: isHome)
    root = try workspace.root()
    let home = try tree(root).filter(isHome)
    try require(home.count == 1, "Home tab unavailable or ambiguous; cannot expose sidebar")
    try sampleDesktop("before-home")
    _ = try activate(
      home[0].element, workspace, window: try windowId(workspace.window, running.processIdentifier),
      what: "Home tab", inputDeadline: inputDeadline
    ) {
      root = try workspace.root()
      return try !sidebars().isEmpty
    }
    let deadline = min(Date().addingTimeInterval(5), inputDeadline ?? .distantFuture)
    while try sidebars().isEmpty && Date() < deadline {
      settle()
      root = try workspace.root()
      try sampleDesktop("wait-sidebar")
    }
    try sampleDesktop("after-home")
    recoverySteps.append("Opened Home to expose channels")
  }
  try require(
    try sidebars().count == 1,
    "Channel sidebar unavailable after Home navigation; inspect before retrying")
}
struct ForewordNodeShape {
  let role: String
  let classes: [String]
  let url: URL?
  let label: String
  let childCount: Int?
  init(
    role: String, classes: [String], url: URL? = nil, label: String = "", childCount: Int? = nil
  ) {
    self.role = role
    self.classes = classes
    self.url = url
    self.label = label
    self.childCount = childCount
  }
}
func isConversationForeword(
  _ id: String, _ rowRole: String, _ rowClasses: [String],
  _ children: [ForewordNodeShape], _ descendants: [ForewordNodeShape], kind: String = "dm",
  descriptionChildren: [ForewordNodeShape] = []
) -> Bool {
  guard id == "message-list_0000000000.000001", rowRole == "AXGroup",
    rowClasses.contains("c-virtual_list__item"), !rowClasses.contains("c-message_kit__actions"),
    !rowClasses.contains("c-timestamp")
  else { return false }
  // Two observed welcome layouts share the description group: the classic
  // avatars/profile-button row and the newer entity avatar/name-button row.
  let layouts = [
    [
      ("AXGroup", "p-message_pane__foreword__avatars"),
      ("AXGroup", "p-message_pane__foreword__description"),
      ("AXButton", "p-message_pane__foreword__profile-button"),
    ],
    [
      ("AXButton", "p-new_im_foreword-entity__avatar-button"),
      ("AXButton", "p-new_im_foreword-entity__name_button"),
      ("AXGroup", "p-message_pane__foreword__description"),
    ],
    // Channel welcome: a title heading and description, followed by action cards.
    [
      ("AXHeading", "p-message_pane__foreword__title"),
      ("AXGroup", "p-message_pane__foreword__description"),
    ],
  ]
  // Only the observed entity introduction owns a profile link. Keep other
  // welcome links and all message-bearing sentinels outside this exception.
  let profileClasses = ["c-link", "c-member_slug", "c-member_slug--light", "c-member_slug--link"]
  func linkedIntroduction() -> Bool {
    guard kind == "dm", descriptionChildren.count == 3,
      layouts[1].allSatisfy({ expectedRole, expectedClass in
        children.filter { $0.role == expectedRole && $0.classes.contains(expectedClass) }.count == 1
      }),
      descriptionChildren[0].role == "AXStaticText",
      descriptionChildren[0].label == "This conversation is just between you and ",
      descriptionChildren[2].role == "AXStaticText",
      descriptionChildren[2].label == ". Take a look at their profile to learn more about them."
    else { return false }
    let profile = descriptionChildren[1]
    guard profile.role == "AXLink", !profile.label.isEmpty,
      profile.classes.count == profileClasses.count,
      profileClasses.allSatisfy({ profile.classes.contains($0) }),
      let url = profile.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme == "https", let host = parts.host, host == host.lowercased(),
      host == "slack.com" || host.hasSuffix(".slack.com"),
      parts.user == nil, parts.password == nil, parts.port == nil,
      parts.query == nil, parts.fragment == nil,
      parts.percentEncodedPath.range(of: #"^/team/U[A-Z0-9]+$"#, options: .regularExpression)
        != nil,
      url.absoluteString == "https://\(host)\(parts.percentEncodedPath)"
    else { return false }
    let links = descendants.filter { $0.role == "AXLink" }
    return links.count == 1 && links[0].url == profile.url
      && links[0].classes == profile.classes && links[0].label == profile.label
  }
  let hasOwnedProfile = linkedIntroduction()
  // DM layouts never authorise a channel row, and the channel layout never a DM row.
  let allowed = kind == "channel" ? Array(layouts.suffix(1)) : Array(layouts.prefix(2))
  return allowed.contains { required in
    required.allSatisfy { expectedRole, expectedClass in
      children.filter { $0.role == expectedRole && $0.classes.contains(expectedClass) }.count == 1
    }
  }
    && !descendants.contains {
      ($0.role == "AXLink" && !hasOwnedProfile) || $0.classes.contains("c-message_kit__actions")
        || $0.classes.contains("c-timestamp")
        || $0.url?.path.range(
          of: #"^/archives/[CDG][A-Z0-9]+/p[0-9]+$"#, options: .regularExpression) != nil
    }
}
func isConversationForeword(_ element: AXUIElement, kind: String = "dm") throws -> Bool {
  let id = string(element, "AXDOMIdentifier")
  guard id == "message-list_0000000000.000001" else { return false }
  func shape(_ element: AXUIElement) -> ForewordNodeShape {
    ForewordNodeShape(
      role: role(element), classes: classes(element), url: attr(element, kAXURLAttribute) as? URL,
      label: label(element))
  }
  let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  let descriptions = children.filter {
    role($0) == "AXGroup" && classes($0).contains("p-message_pane__foreword__description")
  }
  let descriptionChildren =
    descriptions.count == 1
    ? (attr(descriptions[0], kAXChildrenAttribute) as? [AXUIElement] ?? []).map(shape) : []
  let descendants = try tree(element).map { shape($0.element) }
  return isConversationForeword(
    id, role(element), classes(element), children.map(shape), descendants, kind: kind,
    descriptionChildren: descriptionChildren)
}
func isGroupConversationForeword(
  _ id: String, _ rowRole: String, _ rowClasses: [String], _ children: [ForewordNodeShape],
  _ avatars: [ForewordNodeShape], _ descendants: [ForewordNodeShape], _ conversationKind: String,
  _ dmKind: String?
) -> Bool {
  guard conversationKind == "dm", dmKind == "group",
    id == "message-list_0000000000.000001", rowRole == "AXGroup",
    rowClasses.contains("c-virtual_list__item"), children.count >= 6,
    children.last!.role == "AXGroup",
    children.last!.classes.contains("p-message_pane__foreword__notification_setting")
  else { return false }
  let introIndex: Int
  let observedAvatars: [ForewordNodeShape]
  if children[0].role == "AXGroup",
    children[0].classes.contains("p-message_pane__foreword__avatars")
  {
    introIndex = 1
    observedAvatars = avatars
  } else {
    let directAvatarClasses: Set<String> = [
      "c-button-unstyled", "p-message_pane__foreword__avatar", "c-avatar", "c-avatar--interactive",
    ]
    let directAvatarLayouts = [
      directAvatarClasses, directAvatarClasses.union(["c-avatar--deleted_member"]),
      directAvatarClasses.union(["c-button--focus-visible"]),
      directAvatarClasses.union(["c-button--focus-visible", "c-avatar--deleted_member"]),
    ]
    observedAvatars = Array(
      children.prefix { node in
        node.role == "AXButton" && node.childCount == 0
          && directAvatarLayouts.contains { expected in
            node.classes.count == expected.count && Set(node.classes) == expected
          }
      })
    introIndex = observedAvatars.count
  }
  guard introIndex > 0, introIndex < children.count - 1,
    children[introIndex].role == "AXStaticText",
    children[introIndex].label == "This is the very beginning of your direct message history with "
  else { return false }
  func member(_ node: ForewordNodeShape) -> Bool {
    guard node.role == "AXLink", node.classes.contains("c-member_slug"),
      node.classes.contains("c-member_slug--link"), let url = node.url,
      url.scheme == "https", let host = url.host,
      host == "slack.com" || host.hasSuffix(".slack.com"),
      url.user == nil, url.password == nil, url.port == nil, url.query == nil,
      url.fragment == nil
    else { return false }
    return url.absoluteString == "https://\(host)\(url.path)"
      && url.path.range(of: #"^/team/U[A-Z0-9]+$"#, options: .regularExpression)
        == url.path.startIndex..<url.path.endIndex
  }
  let members = Array(children.dropFirst(introIndex + 1).dropLast())
  guard members.count >= 3, members.count % 2 == 1,
    members.enumerated().allSatisfy({ index, node in
      index % 2 == 0
        ? member(node)
        : (node.role == "AXStaticText" && [", ", " and ", ", and "].contains(node.label))
    }), observedAvatars.count == (members.count + 1) / 2,
    observedAvatars.allSatisfy({
      $0.role == "AXButton" && $0.classes.contains("p-message_pane__foreword__avatar")
    })
  else { return false }
  let links = descendants.filter { $0.role == "AXLink" }
  return links.count == observedAvatars.count && links.allSatisfy(member)
    && !rowClasses.contains("c-message_kit__actions") && !rowClasses.contains("c-timestamp")
    && !descendants.contains {
      $0.classes.contains("c-message_kit__actions") || $0.classes.contains("c-timestamp")
        || $0.url?.path.hasPrefix("/archives/") == true
    }
}
func isGroupConversationForeword(_ element: AXUIElement, _ target: [String: Any]) throws -> Bool {
  let id = string(element, "AXDOMIdentifier")
  guard id == "message-list_0000000000.000001", target["kind"] as? String == "dm",
    target["dmKind"] as? String == "group"
  else { return false }
  func shape(_ element: AXUIElement) -> ForewordNodeShape {
    ForewordNodeShape(
      role: role(element), classes: classes(element), url: attr(element, kAXURLAttribute) as? URL,
      label: label(element),
      childCount: (attr(element, kAXChildrenAttribute) as? [AXUIElement])?.count)
  }
  let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  let avatarGroups = children.filter {
    role($0) == "AXGroup" && classes($0).contains("p-message_pane__foreword__avatars")
  }
  guard avatarGroups.count <= 1 else { return false }
  let avatars =
    avatarGroups.first.map {
      (attr($0, kAXChildrenAttribute) as? [AXUIElement] ?? []).map(shape)
    } ?? []
  return try isGroupConversationForeword(
    id, role(element), classes(element), children.map(shape), avatars,
    tree(element).map { shape($0.element) }, "dm", target["dmKind"] as? String)
}
func messagesReady(_ root: AXUIElement, _ target: [String: Any]) throws -> Bool {
  guard let name = target["name"] as? String, let kind = target["kind"] as? String else {
    return false
  }
  let primary = try tree(root).filter {
    classes($0.element).contains("p-workspace__primary_view_body")
  }
  guard primary.count == 1 else { return false }
  func inMainView(_ element: AXUIElement) -> Bool {
    var current = element
    for _ in 0..<40 {
      if classes(current).contains(where: { $0.hasPrefix("p-thread") }) { return false }
      if CFEqual(current, primary[0].element) { return true }
      guard let parent = attr(current, kAXParentAttribute),
        CFGetTypeID(parent) == AXUIElementGetTypeID()
      else { return false }
      current = parent as! AXUIElement
    }
    return false
  }
  let panes = try tree(primary[0].element).filter {
    classes($0.element).contains("p-message_pane") && inMainView($0.element)
  }
  guard panes.count == 1 else { return false }
  let lists = try tree(panes[0].element).filter {
    role($0.element) == "AXList"
      && conversationListLabelMatches(label($0.element), name, target)
  }
  guard lists.count == 1 else { return false }
  for element in attr(lists[0].element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
    guard
      string(element, "AXDOMIdentifier").range(
        of: #"^message-list_\d+\.\d+$"#, options: .regularExpression) != nil
    else { continue }
    if kind == "dm" || kind == "channel", try isConversationForeword(element, kind: kind) {
      continue
    }
    if try isGroupConversationForeword(element, target) {
      continue
    }
    return true
  }
  return false
}

struct MessageLink {
  let url: String
  let host: String
  let conversationId: String
  let messageTS: String
  let threadTS: String?
  init(_ value: String) throws {
    if value.range(of: #"^[CDG][A-Z0-9]+:[0-9]{10}\.[0-9]{6}$"#, options: .regularExpression) != nil
    {
      let parts = value.split(separator: ":")
      self.url = value
      self.host = ""
      self.conversationId = String(parts[0])
      self.messageTS = String(parts[1])
      self.threadTS = nil
      return
    }
    guard let parts = URLComponents(string: value), parts.scheme == "https", let host = parts.host,
      host == "slack.com" || host.hasSuffix(".slack.com"), parts.user == nil, parts.password == nil,
      parts.port == nil || parts.port == 443, parts.fragment == nil,
      parts.path.range(of: #"^/archives/[CDG][A-Z0-9]+/p[0-9]{16}$"#, options: .regularExpression)
        != nil
    else {
      throw Failure(
        description:
          "Use read-thread CONVERSATION:TIMESTAMP from the output, or an HTTPS Slack /archives/CHANNEL/pTIMESTAMP permalink"
      )
    }
    let path = parts.path.split(separator: "/")
    let digits = String(path[2].dropFirst())
    let query = parts.queryItems ?? []
    let threads = query.filter { $0.name == "thread_ts" }
    let channels = query.filter { $0.name == "cid" }
    try require(
      threads.count <= 1 && channels.count <= 1, "Duplicate thread_ts or cid in message permalink")
    let thread = threads.first?.value
    if !threads.isEmpty {
      try require(
        thread?.range(of: #"^[0-9]{10}\.[0-9]{6}$"#, options: .regularExpression) != nil,
        "Invalid thread timestamp in permalink")
    }
    if !channels.isEmpty {
      try require(
        channels[0].value == String(path[1]), "Permalink cid conflicts with its conversation")
    }
    self.url = value
    self.host = host.lowercased()
    self.conversationId = String(path[1])
    self.messageTS = String(digits.dropLast(6)) + "." + String(digits.suffix(6))
    self.threadTS = thread
  }
  func sameMessage(_ other: MessageLink) -> Bool {
    (host == other.host || other.host.isEmpty) && conversationId == other.conversationId
      && messageTS == other.messageTS
  }
}
func messageLink(_ element: AXUIElement) -> MessageLink? {
  guard role(element) == "AXLink", let url = attr(element, kAXURLAttribute) as? URL,
    url.scheme == "https"
  else { return nil }
  return try? MessageLink(url.absoluteString)
}
func ancestor(_ element: AXUIElement, matching predicate: (AXUIElement) -> Bool) -> AXUIElement? {
  var current = element
  for _ in 0..<40 {
    if predicate(current) { return current }
    guard let raw = attr(current, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { return nil }
    current = raw as! AXUIElement
  }
  return nil
}
struct ThreadView {
  let pane: AXUIElement
  let list: AXUIElement
  let header: MessageLink
  let messageTimestamps: [String]
  let replyCount: Int?
  func matches(_ requested: MessageLink) -> Bool {
    (requested.host.isEmpty || header.host == requested.host)
      && header.conversationId == requested.conversationId
      && (requested.threadTS == nil || requested.threadTS == header.messageTS)
      && (requested.messageTS == header.messageTS
        || messageTimestamps.contains(requested.messageTS))
  }
  var loaded: Bool { messageTimestamps.contains { $0 != header.messageTS } || replyCount == 0 }
  func target(_ requested: MessageLink, _ root: AXUIElement) -> [String: Any] {
    [
      "kind": "thread", "conversationId": header.conversationId,
      "requestedMessageTS": requested.messageTS,
      "rootTS": header.messageTS, "requestedURL": requested.url, "requestedHost": header.host,
      "url": (attr(root, kAXURLAttribute) as? URL)?.absoluteString as Any? ?? NSNull(),
    ]
  }
}
// Match the semantic extractor's two supported count surfaces. A native batch
// must not continue past a boundary that semantic output would withhold.
func observedThreadReplyCount(_ separatorLabels: [String], _ listLabel: String) throws -> Int? {
  var values = separatorLabels.compactMap { value -> String? in
    guard value.range(of: #"^[0-9]+ repl(?:y|ies)$"#, options: .regularExpression) != nil else {
      return nil
    }
    return String(value.prefix { $0.isNumber })
  }
  if let range = listLabel.range(
    of: #"(?:\(|,\s*)([0-9]+) repl(?:y|ies)(?=,|\))"#, options: .regularExpression)
  {
    values.append(String(listLabel[range].filter { $0.isNumber }))
  }
  var counts = Set<Int>()
  for value in values {
    guard let count = Int(value), count <= 9_007_199_254_740_991 else {
      throw Failure(description: "Thread reply count is outside supported integer bounds")
    }
    counts.insert(count)
  }
  try require(counts.count <= 1, "Thread reply count changed during capture")
  return counts.first
}
func threadListCaptionMatchesHeader(_ caption: String, _ headerConversationId: String?) -> Bool {
  if caption.hasPrefix("Thread in ") { return true }
  guard let id = headerConversationId,
    id.range(of: #"^D[A-Z0-9]+$"#, options: .regularExpression) == id.startIndex..<id.endIndex
  else { return false }
  return caption.range(
    of: #"^Thread with .+ \(direct message(?:,|\))"#, options: .regularExpression)
    != nil
}
func threadView(_ root: AXUIElement) throws -> ThreadView? {
  let panes = try tree(root).filter { classes($0.element).contains("p-threads_flexpane") }
  try require(panes.count <= 1, "Multiple thread panes exposed; cannot choose a thread")
  guard let pane = panes.first?.element,
    let scope = ancestor(pane, matching: { classes($0).contains("p-view_contents") })
  else { return nil }
  let headers = try tree(scope).filter {
    role($0.element) == "AXLink"
      && classes($0.element).contains("p-threads_flexpane__header_permalink")
  }
  let lists = try tree(pane).filter {
    role($0.element) == "AXList"
      && (label($0.element).hasPrefix("Thread in ") || label($0.element).hasPrefix("Thread with "))
  }
  try require(headers.count <= 1 && lists.count <= 1, "Thread header or message list is ambiguous")
  guard lists.count == 1 else { return nil }
  if label(lists[0].element).hasPrefix("Thread with ") {
    let headerConversationId = headers.first.flatMap { messageLink($0.element)?.conversationId }
    try require(
      threadListCaptionMatchesHeader(label(lists[0].element), headerConversationId),
      "Individual DM thread caption requires its verified direct-message header")
  }
  let rows = attr(lists[0].element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  var rootAnchorFromMain = false
  let header: MessageLink
  if let element = headers.first?.element {
    guard let link = messageLink(element) else {
      throw Failure(description: "Invalid thread header permalink")
    }
    header = link
  } else {
    // Channel side panes omit the header link. Determine the root from message
    // links, then retain a real root permalink from the thread or main history.
    let links = try tree(lists[0].element)
      .filter { classes($0.element).contains("c-timestamp") }
      .compactMap { messageLink($0.element) }
    guard let first = links.first else { return nil }
    try require(
      links.allSatisfy { $0.host == first.host && $0.conversationId == first.conversationId },
      "Thread message links disagree on workspace/conversation")
    var roots = Set(links.compactMap { $0.threadTS })
    if roots.isEmpty, let row = rows.first {
      let expected =
        "\(first.conversationId)-\(first.messageTS)-thread-list-Thread_\(first.messageTS)"
      if string(row, "AXDOMIdentifier") == expected { roots.insert(first.messageTS) }
    }
    guard roots.count == 1, let rootTS = roots.first else { return nil }
    func rootLink(_ candidates: [AXUIElement]) throws -> MessageLink? {
      try require(candidates.count <= 1, "Thread root row is ambiguous")
      guard let row = candidates.first else { return nil }
      let timestamps = try tree(row).filter {
        role($0.element) == "AXLink" && classes($0.element).contains("c-timestamp")
      }
      try require(timestamps.count <= 1, "Thread root timestamp is ambiguous")
      guard let element = timestamps.first?.element, attr(element, kAXURLAttribute) != nil
      else { return nil }
      guard let link = messageLink(element), link.host == first.host,
        link.conversationId == first.conversationId, link.messageTS == rootTS,
        link.threadTS == nil || link.threadTS == rootTS
      else { throw Failure(description: "Thread root permalink has conflicting identity") }
      return link
    }
    var observedRoot = try rootLink(
      rows.filter {
        string($0, "AXDOMIdentifier").hasSuffix("-thread-list-Thread_\(rootTS)")
      })
    if observedRoot == nil,
      (attr(root, kAXURLAttribute) as? URL)?.lastPathComponent == first.conversationId
    {
      let title = label(root)
      let mainPanes = try tree(root).filter {
        classes($0.element).contains("p-message_pane")
          && ancestor(
            $0.element, matching: { classes($0).contains("p-workspace__primary_view_body") }) != nil
          && ancestor(
            $0.element, matching: { classes($0).contains(where: { $0.hasPrefix("p-thread") }) })
            == nil
      }
      try require(mainPanes.count <= 1, "Main conversation pane is ambiguous")
      if let mainPane = mainPanes.first?.element {
        let mainLists = try tree(mainPane).filter {
          role($0.element) == "AXList"
            && mainListMatchesTitle(title, first.conversationId, label($0.element))
        }
        try require(mainLists.count <= 1, "Main conversation message list is ambiguous")
        if let mainList = mainLists.first?.element {
          let mainRows = attr(mainList, kAXChildrenAttribute) as? [AXUIElement] ?? []
          observedRoot = try rootLink(
            mainRows.filter {
              string($0, "AXDOMIdentifier") == "message-list_\(rootTS)"
            })
          rootAnchorFromMain = observedRoot != nil
        }
      }
    }
    guard let observedRoot else { return nil }
    header = observedRoot
  }
  try require(
    header.threadTS == nil || header.threadTS == header.messageTS,
    "Thread header has conflicting root identity")
  var timestamps: [String] = []
  for element in rows {
    let id = string(element, "AXDOMIdentifier")
    let descendants = try tree(element)
    guard
      id.range(
        of: #"^[CDG][A-Z0-9]+-[0-9]{10}\.[0-9]{6}-thread-list-Thread_[0-9]{10}\.[0-9]{6}$"#,
        options: .regularExpression) != nil
    else {
      try require(
        !descendants.contains { classes($0.element).contains("c-message_kit__actions") },
        "Thread message has unsupported row identity")
      continue
    }
    let timestamp = String(id.split(separator: "_").last!)
    let expectedPrefix = "\(header.conversationId)-\(header.messageTS)-thread-list-Thread_"
    let staleNamespace = !id.hasPrefix(expectedPrefix)
    let links = descendants.filter { classes($0.element).contains("c-timestamp") }
    try require(links.count <= 1, "Thread message timestamp is ambiguous")
    if let element = links.first?.element, attr(element, kAXURLAttribute) != nil {
      guard let link = messageLink(element) else {
        throw Failure(description: "Invalid thread message permalink")
      }
      try require(
        link.host == header.host && link.conversationId == header.conversationId
          && link.messageTS == timestamp
          && (link.threadTS == nil || link.threadTS == header.messageTS)
          && ((!staleNamespace && !rootAnchorFromMain) || timestamp == header.messageTS
            || link.threadTS == header.messageTS),
        "Thread message permalink does not verify its row/root")
    } else {
      try require(
        !staleNamespace && (!rootAnchorFromMain || timestamp == header.messageTS),
        "Thread row lacks a verifying permalink")
    }
    timestamps.append(timestamp)
  }
  try require(Set(timestamps).count == timestamps.count, "Duplicate message rows in thread")
  let separatorLabels = try tree(lists[0].element)
    .filter { classes($0.element).contains("p-threads_flexpane__separator") }
    .flatMap { separator in
      try tree(separator.element).filter { role($0.element) == "AXStaticText" }
        .map { label($0.element) }
    }
  let count = try observedThreadReplyCount(separatorLabels, label(lists[0].element))
  try require(
    count == nil || timestamps.filter { $0 != header.messageTS }.count <= count!,
    "More thread replies captured than the displayed count")
  return ThreadView(
    pane: pane, list: lists[0].element, header: header, messageTimestamps: timestamps,
    replyCount: count)
}
struct ThreadSource {
  let timestamp: AXUIElement
  let container: AXUIElement
  let link: MessageLink
}
// A message's thread opener: the conversation's reply-count button, or a search
// result's reply-count pill ("N replies · Last reply …").
func threadReplyControlMatches(_ nodeRole: String, _ names: [String], _ name: String) -> Bool {
  guard nodeRole == "AXButton" else { return false }
  if names.contains("c-message__reply_count") { return true }
  return names.contains("c-search_message__count_pill")
    && name.range(of: #"^[0-9][0-9,]{0,8} (?:reply|replies)\b"#, options: .regularExpression)
      != nil
}
func threadReplyControls(_ container: AXUIElement) throws -> [AXUIElement] {
  try tree(container).filter {
    threadReplyControlMatches(role($0.element), classes($0.element), label($0.element))
  }.map { $0.element }
}
func verifyThreadReplyControl(_ retained: AXUIElement, _ observed: [AXUIElement]) throws {
  try require(
    observed.count == 1 && CFEqual(observed[0], retained),
    "Thread reply control changed before opening; input withheld")
}
func threadSources(_ root: AXUIElement, _ requested: MessageLink) throws -> [ThreadSource] {
  var sources: [ThreadSource] = []
  for node in try tree(root) where classes(node.element).contains("c-timestamp") {
    guard let link = messageLink(node.element), link.sameMessage(requested),
      let container = ancestor(
        node.element, matching: { classes($0).contains("c-message_kit__actions") }),
      ancestor(container, matching: { classes($0).contains("p-threads_flexpane") }) == nil,
      ancestor(
        container,
        matching: {
          classes($0).contains("p-message_pane")
            || (role($0) == "AXList" && label($0).hasPrefix("Message results,"))
        }) != nil
    else { continue }
    try require(
      requested.threadTS == nil || link.threadTS == nil || requested.threadTS == link.threadTS,
      "Observed message and requested thread_ts disagree")
    if let row = ancestor(
      container, matching: { string($0, "AXDOMIdentifier").hasPrefix("message-list_") })
    {
      try require(
        string(row, "AXDOMIdentifier") == "message-list_\(link.messageTS)",
        "Message row identity differs from its permalink")
    }
    sources.append(ThreadSource(timestamp: node.element, container: container, link: link))
  }
  return sources
}
// Which way a virtualized message list must scroll to reach a message that is
// not among its exposed rows. Nil means no scroll can help: the message is
// already exposed, or it would sit between exposed rows and is not in this list.
func threadSourceScrollDirection(_ exposed: [String], _ target: String) -> String? {
  guard let oldest = exposed.first, let newest = exposed.last, exposed == exposed.sorted(),
    Set(exposed).count == exposed.count, !exposed.contains(target)
  else { return nil }
  if target < oldest { return "older" }
  if target > newest { return "newer" }
  return nil
}
func threadSourceRows(_ root: AXUIElement, _ requested: MessageLink) throws -> [PageRow]? {
  guard let url = attr(root, kAXURLAttribute) as? URL,
    url.lastPathComponent == requested.conversationId
  else { return nil }
  let panes = try tree(root).filter {
    classes($0.element).contains("p-message_pane")
      && ancestor(
        $0.element, matching: { classes($0).contains("p-workspace__primary_view_body") }) != nil
      && ancestor(
        $0.element, matching: { classes($0).contains(where: { $0.hasPrefix("p-thread") }) }) == nil
  }
  guard panes.count == 1 else { return nil }
  var rows: [PageRow] = []
  var owner: AXUIElement?
  for node in try tree(panes[0].element) {
    let id = string(node.element, "AXDOMIdentifier")
    guard id.range(of: #"^message-list_[0-9]{10}\.[0-9]{6}$"#, options: .regularExpression) != nil,
      let raw = attr(node.element, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { continue }
    let parent = raw as! AXUIElement
    // Every message row must belong to the same single list.
    guard role(parent) == "AXList", owner.map({ CFEqual($0, parent) }) ?? true else { return nil }
    owner = parent
    rows.append(PageRow(element: node.element, timestamp: String(id.split(separator: "_").last!)))
  }
  let timestamps = rows.map { $0.timestamp }
  guard !rows.isEmpty, Set(timestamps).count == timestamps.count, timestamps == timestamps.sorted()
  else { return nil }
  return rows
}
// The requested message is in the open conversation but outside the exposed
// rows. Scroll toward it one verified edge row at a time, within a bound.
func exposeThreadSource(_ requested: MessageLink, _ workspace: Workspace) throws {
  let target = requested.threadTS ?? requested.messageTS
  let deadline = Date().addingTimeInterval(25)
  var scrolls = 0
  defer {
    if scrolls > 0 {
      recoverySteps.append("Scrolled the conversation \(scrolls) time(s) toward the thread root")
    }
  }
  while scrolls < 20 && Date() < deadline {
    guard let rows = try threadSourceRows(workspace.root(), requested),
      let direction = threadSourceScrollDirection(rows.map { $0.timestamp }, target)
    else { return }
    let before = rows.map { $0.timestamp }
    let edge = direction == "older" ? rows.first! : rows.last!
    guard actions(edge.element).contains("AXScrollToVisible") else { return }
    let window = try windowId(workspace.window, workspace.pid)
    try requireNoModal(workspace.window)
    try sampleDesktop("before-thread-source-scroll")
    var changed = false
    // The row first; if it already fills the viewport, its own leading or
    // trailing element (see pageRowEdge) brings the next rows into view.
    for attempt in 0..<2 where !changed {
      let scrolled: AXUIElement
      if attempt == 0 {
        scrolled = edge.element
      } else {
        guard let inner = try pageRowEdge(edge.element, leading: direction == "older") else {
          break
        }
        scrolled = inner
      }
      let accepted = try finalWindowInput(
        window, currentWindow: { try windowId(workspace.window, workspace.pid) },
        noModal: { try requireNoModal(workspace.window) },
        verifyControl: {
          let fresh = try threadSourceRows(workspace.root(), requested) ?? []
          try require(
            fresh.map { $0.timestamp } == before
              && fresh.contains { CFEqual($0.element, edge.element) },
            "Messages changed before scrolling to the thread root; no scroll posted")
        },
        input: { () throws -> AXError in
          try interactionAXAction(scrolled, "AXScrollToVisible" as CFString)
        })
      guard accepted == .success else { return }
      scrolls += 1
      let settleDeadline = min(deadline, Date().addingTimeInterval(attempt == 0 ? 3 : 4))
      var previous = before
      repeat {
        settle()
        try sampleDesktop("verify-thread-source-scroll")
        // A changed conversation or list shape ends the attempt without more input.
        guard let current = try threadSourceRows(workspace.root(), requested) else { return }
        let ids = current.map { $0.timestamp }
        if ids != before && ids == previous {
          changed = true
          break
        }
        if ids == before && previous == before && attempt == 0 { break }
        previous = ids
      } while Date() < settleDeadline
    }
    // No new rows after a scroll: the edge of loaded history, or no progress.
    if !changed { return }
  }
}
// The thread side pane's own Close button: an enabled header control, nothing else.
func threadCloseButtonMatches(
  _ nodeRole: String, _ name: String, _ names: [String], _ enabled: Bool
) -> Bool {
  nodeRole == "AXButton" && name == "Close" && names.contains("p-flexpane_header__control")
    && enabled
}
func threadPaneScope(_ root: AXUIElement) throws -> AXUIElement? {
  let panes = try tree(root).filter { classes($0.element).contains("p-threads_flexpane") }
  try require(panes.count <= 1, "Multiple thread panes exposed; cannot choose a thread")
  guard let pane = panes.first?.element else { return nil }
  guard let scope = ancestor(pane, matching: { classes($0).contains("p-view_contents") }) else {
    throw Failure(description: "Thread pane scope is unavailable")
  }
  return scope
}
func threadCloseControl(_ scope: AXUIElement) throws -> AXUIElement {
  let toolbars = try tree(scope).filter {
    role($0.element) == "AXToolbar" && classes($0.element).contains("p-flexpane_header")
  }
  try require(toolbars.count == 1, "Thread pane header is unavailable or ambiguous")
  let buttons = try tree(toolbars[0].element).filter {
    threadCloseButtonMatches(
      role($0.element), label($0.element), classes($0.element),
      (attr($0.element, kAXEnabledAttribute) as? Bool) == true)
  }
  try require(buttons.count == 1, "Thread close control is unavailable or ambiguous")
  return buttons[0].element
}
// Preserve the seven-digit bound while accepting only complete comma groups.
func channelMemberNumber(_ text: String) -> Int? {
  guard
    text.range(
      of: #"\A(?:[0-9]{1,7}|[1-9][0-9]{0,2}(?:,[0-9]{3}){1,2})\z"#,
      options: .regularExpression) != nil
  else { return nil }
  let digits = text.replacingOccurrences(of: ",", with: "")
  guard digits.count <= 7 else { return nil }
  return Int(digits)
}
func membersTabCount(_ name: String) -> Int? {
  guard name.hasPrefix("Members ") else { return nil }
  return channelMemberNumber(String(name.dropFirst("Members ".count)))
}
// Rounded labels identify this tab, never an exact membership total.
func membersRoundedTabLabel(_ name: String) -> Bool {
  name.range(of: #"\AMembers [1-9][0-9]{0,3}k\z"#, options: .regularExpression) != nil
}
func membersCountEvidenceMatches(
  _ total: Int, _ retainedLabel: String, _ currentLabel: String, _ headerCount: Int?
) -> Bool {
  guard total >= 0, retainedLabel == currentLabel else { return false }
  if let exact = membersTabCount(currentLabel) { return exact == total }
  return membersRoundedTabLabel(currentLabel) && headerCount == total
}
// The member count advertised by the channel header's avatar-stack button,
// e.g. "View all 26 members. Includes …". Nil for any other label.
func channelMemberCount(_ name: String) -> Int? {
  if name == "View 1 member. Includes you." { return 1 }
  guard
    let match = name.range(
      of: #"\AView all ([0-9,]{1,9}) members?(?:\.|\z)"#, options: .regularExpression)
  else { return nil }
  let number = name[match].dropFirst("View all ".count).prefix { $0 != " " }
  return channelMemberNumber(String(number))
}
// One member row: a list item whose DOM id is the member's user ID.
func memberRowMatches(_ nodeRole: String, _ id: String, _ names: [String]) -> Bool {
  nodeRole == "AXGroup"
    && id.range(of: #"\A[UW][A-Z0-9]{2,30}\z"#, options: .regularExpression) != nil
    && names.contains("p-ia_details_popover__members_list_item_member")
}
func channelDetailsDialog(_ workspace: Workspace, _ channel: String) throws -> AXUIElement? {
  let dialogs = try tree(workspace.root()).filter {
    classes($0.element).contains("c-sk-modal")
      && classes($0.element).contains("ReactModal__Content")
  }
  try require(dialogs.count <= 1, "Multiple dialogs are open; input withheld")
  guard let dialog = dialogs.first?.element else { return nil }
  // Labelled with or without the "#", depending on the client build.
  try require(
    ["Details for channel #\(channel)", "Details for channel \(channel)"].contains(label(dialog)),
    "An unrelated dialog is open; close it before reading members")
  return dialog
}
struct MemberCapture {
  let list: AXUIElement
  let rows:
    [(id: String, name: String?, title: String?, profileLabel: String?, element: AXUIElement)]
}
// A leaf profile button exposes one accessible label, which may combine a name,
// guest marker and title. Keep it whole; no substring becomes an inferred name.
func memberLeafProfileLabel(
  _ nodeRole: String, _ names: [String], _ childCount: Int?, _ observed: String,
  _ directParent: Bool
) -> String? {
  guard nodeRole == "AXButton", names.contains("c-button-unstyled"), childCount == 0,
    directParent, observed.unicodeScalars.count <= 2_000,
    !observed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    !observed.unicodeScalars.contains(where: {
      // Reject actual controls, preserving format characters in this opaque display label.
      $0.properties.generalCategory == .control
    })
  else { return nil }
  return observed
}
func memberCapture(_ dialog: AXUIElement, verifiedList: AXUIElement? = nil) throws -> MemberCapture?
{
  let lists =
    try verifiedList.map { [Node(element: $0, depth: 0)] }
    ?? tree(dialog).filter {
      role($0.element) == "AXList" && label($0.element) == "Members in channel"
    }
  try require(lists.count <= 1, "Member list is ambiguous")
  guard let list = lists.first?.element else { return nil }
  var rows:
    [(id: String, name: String?, title: String?, profileLabel: String?, element: AXUIElement)] = []
  for row in accessibilityChildren(list) {
    let id = string(row, "AXDOMIdentifier")
    guard memberRowMatches(role(row), id, classes(row)) else { continue }
    let buttons = accessibilityChildren(row).filter { role($0) == "AXButton" }
    try require(buttons.count == 1, "Member row has no unique profile button")
    let profile = buttons[0]
    let parent = liveAttr(profile, kAXParentAttribute)
    let directParent =
      parent.map {
        CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, row)
      } == true
    try require(directParent, "Member profile button does not belong to its member row")
    let rawParts = liveAttr(profile, kAXChildrenAttribute) as? [AXUIElement]
    if let observed = memberLeafProfileLabel(
      role(profile), classes(profile), rawParts?.count, label(profile), directParent)
    {
      rows.append((id, nil, nil, observed, row))
      continue
    }
    // The display name is the first group's text; any further text is the title.
    let parts = rawParts ?? []
    let nameTexts =
      parts.first.map { group in
        accessibilityChildren(group).filter { role($0) == "AXStaticText" }.map {
          scalarValue($0) ?? label($0)
        }
      } ?? []
    let name = nameTexts.joined().trimmingCharacters(in: .whitespacesAndNewlines)
    try require(!name.isEmpty, "Member row has no exposed name")
    let rest = parts.dropFirst().filter { role($0) == "AXStaticText" }
      .map { (scalarValue($0) ?? label($0)).trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty && $0 != name }
    // Further text is the full name and/or profile title, shown after the display name.
    rows.append((id, name, rest.isEmpty ? nil : rest.joined(separator: " "), nil, row))
  }
  return MemberCapture(list: list, rows: rows)
}
func membersRuntimeLimit(_ raw: String?, _ requestedPages: Int) throws -> Int {
  guard let raw else { return requestedPages == 0 ? 160 : 70 }
  try require(
    raw.range(of: #"\A[1-9][0-9]{0,2}\z"#, options: .regularExpression) != nil
      && Int(raw).map { (1...900).contains($0) } == true,
    "Specify --max-seconds once with a canonical integer from 1 to 900")
  return Int(raw)!
}
func membersFinalStopReason(_ reason: String, expired: Bool) -> String {
  reason == "complete" ? reason : expired ? "time-limit" : reason
}
enum MembersCollectionStop: Error { case deadline }
func membersBeforeDeadline<T>(
  _ deadline: Date, now: () -> Date = { Date() }, operation: () throws -> T
) throws -> T {
  guard now() < deadline else { throw MembersCollectionStop.deadline }
  return try operation()
}
func membersCheckpoint<T>(
  cancelled: () -> Bool, sample: () throws -> Void, verify: () throws -> Void,
  operation: () throws -> T
) throws -> T {
  try require(!cancelled(), "Members read interrupted; dialog left open")
  try sample()
  try require(!cancelled(), "Members read interrupted; dialog left open")
  try verify()
  try require(!cancelled(), "Members read interrupted; dialog left open")
  try sample()
  try require(!cancelled(), "Members read interrupted; dialog left open")
  return try operation()
}
func membersReadSourceMatches(
  _ expected: MembersCloseChannel, _ observed: MembersCloseChannel?,
  expectedWindow: Int, observedWindow: Int, expectedTotal: Int, observedTotal: Int?
) -> Bool {
  expected == observed && expectedWindow == observedWindow
    && expectedTotal >= 0 && expectedTotal == observedTotal
}
struct MembersReadEdge<T: Hashable>: Equatable {
  let child: T
  let parent: T
  let siblings: [T]
}
func membersReadEdgesMatch<T: Hashable>(
  _ expected: [MembersReadEdge<T>], _ observed: [MembersReadEdge<T>]
) -> Bool {
  !expected.isEmpty && expected == observed
    && expected.allSatisfy { edge in
      edge.child != edge.parent && edge.siblings.filter { $0 == edge.child }.count == 1
        && Set(edge.siblings).count == edge.siblings.count
    }
}
func membersReadEdges(_ paths: [(AXUIElement, AXUIElement)]) throws -> [MembersReadEdge<AXIdentity>]
{
  var result: [MembersReadEdge<AXIdentity>] = []
  var retained = Set<AXIdentity>()
  for (start, end) in paths {
    var child = start
    var visited = Set<AXIdentity>()
    while !CFEqual(child, end) {
      try require(
        visited.count < 24 && visited.insert(AXIdentity(element: child)).inserted,
        "Member source ancestry is repeated or exceeds bounds")
      guard let raw = liveAttr(child, kAXParentAttribute),
        CFGetTypeID(raw) == AXUIElementGetTypeID(),
        let siblings = liveAttr(raw as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]
      else { throw Failure(description: "Member source ancestry is unavailable") }
      let parent = raw as! AXUIElement
      let identity = AXIdentity(element: child)
      try require(
        siblings.filter { CFEqual($0, child) }.count == 1,
        "Member source is not uniquely owned by its retained parent")
      if retained.insert(identity).inserted {
        result.append(
          MembersReadEdge(
            child: identity, parent: AXIdentity(element: parent),
            siblings: siblings.map { AXIdentity(element: $0) }))
      }
      child = parent
    }
  }
  return result
}
func memberLiveLabel(_ element: AXUIElement) -> String {
  liveAttrs(element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute])
    .compactMap { $0 as? String }.first(where: { !$0.isEmpty }) ?? ""
}
func memberLiveValue(_ element: AXUIElement) -> String? {
  let value = liveAttr(element, kAXValueAttribute)
  return (value as? String) ?? (value as? NSNumber)?.stringValue
}
func membersAllFilterMatches(
  _ nodeRole: String, _ id: String, _ label: String, _ value: String?, _ names: [String]
) -> Bool {
  nodeRole == "AXComboBox" && id == "ia-details-popover-members--filter-select_button"
    && label == "Filter by: All" && value == "All"
    && names.contains("c-select_button") && names.contains("c-select_button--medium")
}
// Full modal inventory is verified when binding and closing. During paging,
// retain and reread only the ownership paths, source and selected controls;
// member rows are intentionally outside the retained child inventories.
func verifyMembersReadSource(
  _ workspace: Workspace, _ root: AXUIElement, _ scope: MembersCloseScope, _ window: Int,
  _ total: Int, _ filter: AXUIElement, _ edges: [MembersReadEdge<AXIdentity>],
  _ paths: [(AXUIElement, AXUIElement)], _ header: AXUIElement?
) throws {
  let source = liveAttrs(root, [kAXRoleAttribute, kAXURLAttribute, kAXWindowAttribute])
  guard source[0] as? String == "AXWebArea", let url = source[1] as? URL,
    let rawWindow = source[2], CFGetTypeID(rawWindow) == AXUIElementGetTypeID()
  else { throw Failure(description: "Member channel source is unavailable") }
  let tabLabel = memberLiveLabel(scope.tab)
  let headerCount = header.flatMap { channelMemberCount(memberLiveLabel($0)) }
  let observedTotal =
    membersTabCount(tabLabel)
    ?? (membersRoundedTabLabel(tabLabel) ? headerCount : nil)
  try require(
    CFEqual(rawWindow, workspace.window)
      && membersReadSourceMatches(
        scope.channel,
        membersCloseChannel(memberLiveLabel(root), url, memberLiveLabel(scope.dialog)),
        expectedWindow: window, observedWindow: try windowId(workspace.window, workspace.pid),
        expectedTotal: total, observedTotal: observedTotal),
    "Member channel URL, title or window changed; read and input withheld")
  try require(
    membersReadEdgesMatch(edges, try membersReadEdges(paths)),
    "Member dialog, tab or list ownership changed; read and input withheld")
  let tab = liveAttrs(
    scope.tab, [kAXRoleAttribute, "AXDOMIdentifier", "AXDOMClassList", kAXSelectedAttribute])
  try require(
    membersCloseTabMatches(
      tab[0] as? String ?? "", tab[1] as? String ?? "", memberLiveLabel(scope.tab),
      tab[2] as? [String] ?? [], memberLiveValue(scope.tab), tab[3] as? Bool == true)
      && membersCountEvidenceMatches(total, scope.tabLabel, tabLabel, headerCount),
    "Selected Members tab or advertised count changed; read and input withheld")
  if let header {
    let values = liveAttrs(header, [kAXRoleAttribute, "AXDOMClassList"])
    try require(
      values[0] as? String == "AXButton"
        && (values[1] as? [String] ?? []).contains("p-avatar_stack--details")
        && channelMemberCount(memberLiveLabel(header)) == total,
      "Exact member header count changed; read and input withheld")
  }
  guard let tabParent = edges.first(where: { $0.child == AXIdentity(element: scope.tab) }) else {
    throw Failure(description: "Members tab ownership is unavailable")
  }
  let menu = liveAttrs(tabParent.parent.element, [kAXRoleAttribute, "AXDOMClassList"])
  let dialogClasses = liveAttr(scope.dialog, "AXDOMClassList") as? [String] ?? []
  try require(
    membersCloseTabGroupMatches(
      menu[0] as? String ?? "", memberLiveLabel(tabParent.parent.element),
      menu[1] as? [String] ?? [], scope.channel.name)
      && dialogClasses.contains("c-sk-modal") && dialogClasses.contains("ReactModal__Content")
      && tabParent.siblings.filter { memberLiveValue($0.element) == "1" }.count == 1,
    "Members tab is no longer uniquely selected")
  let panel = liveAttrs(scope.panel, [kAXRoleAttribute, kAXSubroleAttribute, "AXDOMClassList"])
  let panelClasses = panel[2] as? [String] ?? []
  try require(
    panel[0] as? String == "AXGroup" && panel[1] as? String == "AXTabPanel"
      && panelClasses.contains("p-about_modal__tab_panel")
      && panelClasses.contains("c-tabs__tab_panel--active")
      && liveAttr(scope.list, kAXRoleAttribute) as? String == "AXList"
      && memberLiveLabel(scope.list) == "Members in channel",
    "Members panel or list changed; read and input withheld")
  let filterValues = liveAttrs(filter, [kAXRoleAttribute, "AXDOMIdentifier", "AXDOMClassList"])
  try require(
    membersAllFilterMatches(
      filterValues[0] as? String ?? "", filterValues[1] as? String ?? "", memberLiveLabel(filter),
      memberLiveValue(filter), filterValues[2] as? [String] ?? []),
    "Members filter is not verified All; read and input withheld")
}
// Opens the channel's details dialog on its Members tab, collects the exposed
// member rows with bounded scrolling, then closes the dialog it opened.
func readChannelMembers(
  _ target: [String: Any], _ workspace: Workspace, _ requestedPages: Int, _ maxSeconds: Int
) throws -> [String: Any] {
  guard let channel = target["name"] as? String, let url = target["url"] as? String else {
    throw Failure(description: "Channel identity is unavailable")
  }
  try require((1...900).contains(maxSeconds), "Members time limit is outside 1 to 900 seconds")
  let root = try workspace.root()
  // An already-open details dialog for this exact channel is reused, then closed,
  // so no dialog is left covering the rest of Slack.
  let reused = try channelDetailsDialog(workspace, channel) != nil
  let headers = try tree(root).filter {
    role($0.element) == "AXToolbar" && classes($0.element).contains("p-view_header")
      && ancestor(
        $0.element,
        matching: { classes($0).contains("p-view_contents--primary") }) != nil
  }
  try require(reused || headers.count == 1, "Channel header is unavailable or ambiguous")
  let buttons = try tree(root).filter {
    role($0.element) == "AXButton" && classes($0.element).contains("p-avatar_stack--details")
      && channelMemberCount(label($0.element)) != nil
  }
  try require(
    reused || buttons.count == 1, "Channel member control is unavailable or ambiguous")
  let opener = buttons.first?.element
  let window = try windowId(workspace.window, workspace.pid)
  if !reused { try requireNoModal(workspace.window) }
  try sampleDesktop("before-open-members")
  var total = opener.flatMap { channelMemberCount(label($0)) }
  var opened = false
  var closed = false
  var members: [[String: Any]] = []
  var seen = Set<String>()
  var pages = 0
  var stopReason = "page-limit"
  var filterReceipt: [String: Any] = ["status": "unknown", "value": NSNull()]
  do {
    if !reused, let opener {
      try finalWindowInput(
        window, currentWindow: { try windowId(workspace.window, workspace.pid) },
        noModal: { try requireNoModal(workspace.window) },
        verifyControl: {
          // Same predicate as the initial lookup: other avatar stacks without a
          // member count (e.g. huddles) must not make the control look changed.
          let fresh = try tree(workspace.root()).filter {
            role($0.element) == "AXButton"
              && classes($0.element).contains("p-avatar_stack--details")
              && channelMemberCount(label($0.element)) != nil
          }
          try require(
            fresh.count == 1 && CFEqual(fresh[0].element, opener),
            "Member control changed before opening; input withheld")
        },
        input: {
          opened = true
          try press(opener)
        })
    }
    var dialog: AXUIElement?
    let openDeadline = Date().addingTimeInterval(5)
    repeat {
      settle()
      try sampleDesktop("wait-members-dialog")
      dialog = try channelDetailsDialog(workspace, channel)
    } while dialog == nil && Date() < openDeadline
    guard let dialog else { throw Failure(description: "Channel details did not open") }
    // The button normally opens the Members tab; select it only if it did not.
    let tabs = try tree(dialog).filter {
      role($0.element) == "AXRadioButton" && string($0.element, "AXDOMIdentifier") == "members"
    }
    try require(tabs.count == 1, "Members tab is unavailable or ambiguous")
    // The tab label carries the count too, e.g. "Members 26".
    let tabCount = membersTabCount(label(tabs[0].element))
    if let tabCount {
      try require(
        total == nil || total == tabCount, "Member counts disagree between header and dialog")
      total = tabCount
    }
    guard let total else { throw Failure(description: "Member count is not exposed") }
    if scalarValue(tabs[0].element) != "1" {
      let tabRoot = try workspace.root()
      guard let tabURL = liveAttr(tabRoot, kAXURLAttribute) as? URL else {
        throw Failure(description: "Members channel source is unavailable before tab selection")
      }
      try sampleDesktop("before-select-members-tab")
      try require(
        (try windowId(workspace.window, workspace.pid)) == window
          && tabURL.absoluteString == url
          && conversationTitleMatches(memberLiveLabel(tabRoot), channel, .channel)
          && (try channelDetailsDialog(workspace, channel)).map { CFEqual($0, dialog) } == true,
        "Members source changed before tab selection")
      try press(tabs[0].element)
      settle()
    }
    let exactHeader = membersRoundedTabLabel(label(tabs[0].element)) ? opener : nil
    if let exactHeader {
      try require(
        buttons.count == 1 && headers.count == 1
          && (try tree(headers[0].element)).contains { CFEqual($0.element, exactHeader) },
        "Rounded member tab has no unique channel-owned exact header count")
    }
    guard let scope = try membersCloseScope(workspace), CFEqual(scope.dialog, dialog),
      scope.channel.name == channel, scope.channel.url == url,
      membersCountEvidenceMatches(
        total, scope.tabLabel, memberLiveLabel(scope.tab),
        exactHeader.flatMap { channelMemberCount(memberLiveLabel($0)) })
    else { throw Failure(description: "Members source could not be bound before reading") }
    let filters = try tree(scope.dialog).filter {
      string($0.element, "AXDOMIdentifier") == "ia-details-popover-members--filter-select_button"
    }
    try require(filters.count == 1, "Members filter is unavailable or ambiguous; All is unverified")
    let filter = filters[0].element
    filterReceipt = [
      "status": "observed", "label": memberLiveLabel(filter),
      "value": memberLiveValue(filter) as Any? ?? NSNull(),
    ]
    try require(
      membersAllFilterMatches(
        role(filter), string(filter, "AXDOMIdentifier"), memberLiveLabel(filter),
        memberLiveValue(filter), classes(filter)),
      "Members filter is not verified All; collection withheld")
    filterReceipt["status"] = "verified-all"
    let sourceRoot = try workspace.root()
    var paths: [(AXUIElement, AXUIElement)] = [
      (scope.tab, scope.dialog), (scope.list, scope.panel), (scope.panel, scope.dialog),
      (scope.control, scope.dialog), (scope.dialog, sourceRoot), (sourceRoot, workspace.window),
      (filter, scope.dialog),
    ]
    if let exactHeader { paths.append((exactHeader, sourceRoot)) }
    let edges = try membersReadEdges(paths)
    func checked<T>(_ stage: String, _ operation: () throws -> T) throws -> T {
      try membersCheckpoint(
        cancelled: { interrupted },
        sample: {
          // Drain pending signal delivery before another capture or action.
          settle(0.001)
          try sampleDesktop(stage)
        },
        verify: {
          try verifyMembersReadSource(
            workspace, sourceRoot, scope, window, total, filter, edges, paths, exactHeader)
        }, operation: operation)
    }
    // Each scroll exposes roughly seven more rows. With no --pages cap
    // (requestedPages == 0) keep going until every advertised member is read,
    // progress stops, or the time bound is reached; --pages=N caps the read at
    // 3N captures.
    let maxCaptures = requestedPages == 0 ? 2_000 : requestedPages * 3
    let deadline = Date().addingTimeInterval(TimeInterval(maxSeconds))
    do {
      while pages < maxCaptures && Date() < deadline {
        var capture = try checked("before-members-capture") {
          try membersBeforeDeadline(deadline) {
            try memberCapture(dialog, verifiedList: scope.list)
          }
        }
        let loadDeadline = min(Date().addingTimeInterval(4), deadline)
        while total > 0 && (capture?.rows.isEmpty ?? true) && Date() < loadDeadline {
          settle()
          capture = try checked("wait-members-capture") {
            try membersBeforeDeadline(deadline) {
              try memberCapture(dialog, verifiedList: scope.list)
            }
          }
        }
        guard let capture, CFEqual(capture.list, scope.list), total == 0 || !capture.rows.isEmpty
        else {
          throw Failure(description: "Member list did not load")
        }
        try checked("after-members-capture") {}
        pages += 1
        var added = 0
        for row in capture.rows where seen.insert(row.id).inserted {
          added += 1
          var record: [String: Any] = [
            "id": row.id, "name": row.name.map { $0 as Any } ?? NSNull(),
          ]
          if let title = row.title { record["title"] = title }
          if let profileLabel = row.profileLabel { record["label"] = profileLabel }
          members.append(record)
        }
        try require(
          members.count <= total, "Collected members exceed the verified advertised count")
        if members.count == total {
          stopReason = "complete"
          break
        }
        if pages > 1 && added == 0 {
          stopReason = "no-progress"
          break
        }
        if pages >= maxCaptures || Date() >= deadline { break }
        let edge = capture.rows.last!.element
        guard actions(edge).contains("AXScrollToVisible") else {
          stopReason = "no-scroll"
          break
        }
        try checked("before-members-scroll") {
          let source = liveAttrs(edge, ["AXDOMIdentifier", kAXParentAttribute])
          guard source[0] as? String == capture.rows.last!.id, let parent = source[1],
            CFGetTypeID(parent) == AXUIElementGetTypeID(), CFEqual(parent, scope.list),
            let rows = liveAttr(scope.list, kAXChildrenAttribute) as? [AXUIElement]
          else { throw Failure(description: "Member scroll edge changed; scroll withheld") }
          try require(
            rows.filter { CFEqual($0, edge) }.count == 1,
            "Member scroll edge is not uniquely owned by the verified list")
          settle(0.001)
          try sampleDesktop("members-scroll-ready")
          try require(!interrupted, "Members read interrupted; scroll withheld")
          try membersBeforeDeadline(deadline) {
            try require(
              try interactionAXAction(edge, "AXScrollToVisible" as CFString) == .success,
              "Member list did not accept background scrolling")
          }
        }
        settle()
      }
    } catch MembersCollectionStop.deadline {
      stopReason = "time-limit"
    }
    stopReason = membersFinalStopReason(stopReason, expired: Date() >= deadline)
    try require(
      pages > 0 || stopReason == "time-limit", "Members collection has no verified capture")
    try checked("before-members-close") {
      guard let fresh = try membersCloseScope(workspace), scope.sameIdentity(fresh),
        membersCountEvidenceMatches(
          total, scope.tabLabel, memberLiveLabel(fresh.tab),
          exactHeader.flatMap { channelMemberCount(memberLiveLabel($0)) })
      else { throw Failure(description: "Member dialog changed before close; close withheld") }
      try verifyMembersReadSource(
        workspace, sourceRoot, scope, window, total, filter, edges, paths, exactHeader)
      settle(0.001)
      try sampleDesktop("members-close-ready")
      try require(!interrupted, "Members read interrupted; close withheld")
      try press(scope.control)
    }
    let closeDeadline = Date().addingTimeInterval(4)
    repeat {
      settle()
      try sampleDesktop("verify-members-close")
      let freshRoot = try workspace.root()
      guard let freshURL = liveAttr(freshRoot, kAXURLAttribute) as? URL else {
        throw Failure(description: "Member channel disappeared after close")
      }
      try require(
        membersCloseChannel(memberLiveLabel(freshRoot), freshURL, "Details for channel \(channel)")
          == scope.channel && (try windowId(workspace.window, workspace.pid)) == window,
        "Member channel or window changed after close")
      if try channelDetailsDialog(workspace, channel) == nil { closed = true }
    } while !closed && Date() < closeDeadline
    try require(closed, "Channel details closure is unverified; inspect before retrying")
    try require(
      pages > 0 || total > 0,
      "Members collection expired before verifying the advertised empty list; dialog closed")
  } catch {
    return [
      "operation": "members", "status": "stopped", "error": String(describing: error),
      "dialogOpened": opened, "dialogReused": reused, "dialogClosed": closed,
      "pid": workspace.pid,
      "maxSeconds": maxSeconds, "desktopSamples": desktopSamples,
      "memberFilter": filterReceipt,
      "next": "Inspect the current Slack view before another request; no input is replayed.",
      "recovery": recoverySteps,
    ]
  }
  return [
    "operation": "members", "status": "ok", "pid": workspace.pid,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "channel": ["name": channel, "url": url],
    // "listPages", not "pages": scoped receipts reserve "pages" for page arrays.
    "total": total as Any, "members": members, "listPages": pages, "stopReason": stopReason,
    "maxSeconds": maxSeconds, "desktopSamples": desktopSamples,
    "memberFilter": filterReceipt,
    "dialogOpened": opened, "dialogReused": reused, "dialogClosed": closed,
    "recovery": recoverySteps,
  ]
}
// Closing members is independent of member-row parsing: an unsupported profile
// row must not prevent recovery from this exact, source-bound details dialog.
struct MembersCloseChannel: Equatable {
  let name: String
  let id: String
  let url: String
  var receipt: [String: Any] { ["name": name, "id": id, "url": url] }
}
func membersCloseChannel(_ title: String, _ url: URL, _ dialogLabel: String)
  -> MembersCloseChannel?
{
  let prefix = "Details for channel "
  guard dialogLabel.hasPrefix(prefix) else { return nil }
  var name = String(dialogLabel.dropFirst(prefix.count))
  if name.hasPrefix("#") { name.removeFirst() }
  guard name.range(of: #"\A[\p{L}\p{N}_-]+\z"#, options: .regularExpression) != nil,
    url.scheme == "https", url.host == "app.slack.com", url.port == nil,
    url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
    url.pathComponents.count == 4, url.pathComponents[1] == "client",
    url.pathComponents[2].range(of: #"\A[TE][A-Z0-9]+\z"#, options: .regularExpression) != nil,
    destinationMatches(title, url.lastPathComponent, name, .channel)
  else { return nil }
  return MembersCloseChannel(name: name, id: url.lastPathComponent, url: url.absoluteString)
}
func membersCloseModalMatches(
  _ nodeRole: String, _ subrole: String, _ names: [String], _ modal: Bool
) -> Bool {
  ["AXDialog", "AXSheet", "AXMenu", "AXPopover"].contains(nodeRole)
    || ["AXDialog", "AXApplicationDialog"].contains(subrole) || modal
    || names.contains("c-sk-modal") || names.contains("ReactModal__Content")
}
func membersCloseTabMatches(
  _ nodeRole: String, _ id: String, _ name: String, _ names: [String], _ value: String?,
  _ selected: Bool
) -> Bool {
  nodeRole == "AXRadioButton" && id == "members"
    && (membersTabCount(name) != nil || membersRoundedTabLabel(name))
    && names.contains("c-tabs__tab--active") && value == "1" && selected
}
func membersCloseTabGroupMatches(
  _ nodeRole: String, _ name: String, _ names: [String], _ channel: String
) -> Bool {
  nodeRole == "AXTabGroup" && names.contains("c-tabs__tab_menu") && !channel.isEmpty
    && ["Details for channel \(channel)", "Details for channel #\(channel)"].contains(name)
}
func membersCloseButtonMatches(
  _ nodeRole: String, _ name: String, _ names: [String], _ enabled: Bool,
  _ advertisedActions: [String], _ directChild: Bool
) -> Bool {
  nodeRole == "AXButton" && name == "Close" && names.contains("c-sk-modal__close_button")
    && enabled && advertisedActions.contains(kAXPressAction) && directChild
}
func membersCloseModalState(_ workspace: Workspace, _ owned: AXUIElement?) throws {
  let blockers = try tree(workspace.window).filter {
    membersCloseModalMatches(
      role($0.element), string($0.element, kAXSubroleAttribute), classes($0.element),
      (attr($0.element, "AXModal") as? Bool) == true)
  }.map { $0.element }
  try require(
    ownedSurfaceMatches(blockers, owned), "Unrelated or ambiguous dialog blocks close-members")
  try require(try queryFields(workspace.root()).isEmpty, "Search picker blocks close-members")
}
struct MembersCloseScope {
  let channel: MembersCloseChannel
  let dialog: AXUIElement
  let tab: AXUIElement
  let tabLabel: String
  let panel: AXUIElement
  let list: AXUIElement
  let control: AXUIElement
  func sameIdentity(_ other: MembersCloseScope) -> Bool {
    channel == other.channel && CFEqual(dialog, other.dialog) && CFEqual(tab, other.tab)
      && tabLabel == other.tabLabel
      && CFEqual(panel, other.panel) && CFEqual(list, other.list) && CFEqual(control, other.control)
  }
}
func membersCloseScope(_ workspace: Workspace) throws -> MembersCloseScope? {
  let root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Search picker blocks close-members")
  let dialogs = try tree(root).filter {
    classes($0.element).contains("c-sk-modal")
      && classes($0.element).contains("ReactModal__Content")
  }
  try require(dialogs.count <= 1, "Multiple dialogs are open; no close requested")
  guard let dialog = dialogs.first?.element else {
    try membersCloseModalState(workspace, nil)
    return nil
  }
  try membersCloseModalState(workspace, dialog)
  guard let url = attr(root, kAXURLAttribute) as? URL,
    let channel = membersCloseChannel(label(root), url, label(dialog))
  else {
    throw Failure(
      description: "Member dialog does not match the current channel; no close requested")
  }
  let menus = accessibilityChildren(dialog).filter {
    membersCloseTabGroupMatches(role($0), label($0), classes($0), channel.name)
  }
  try require(menus.count == 1, "Channel-details tab group is unavailable or ambiguous")
  let tabs = accessibilityChildren(menus[0]).filter {
    role($0) == "AXRadioButton" && string($0, "AXDOMIdentifier") == "members"
  }
  try require(tabs.count == 1, "Members tab is unavailable or ambiguous")
  let tab = tabs[0]
  try require(
    membersCloseTabMatches(
      role(tab), string(tab, "AXDOMIdentifier"), label(tab), classes(tab), scalarValue(tab),
      (attr(tab, kAXSelectedAttribute) as? Bool) == true)
      && accessibilityChildren(menus[0]).filter { scalarValue($0) == "1" }.count == 1,
    "Members tab is not uniquely selected; no close requested")
  let panels = accessibilityChildren(dialog).filter {
    role($0) == "AXGroup" && string($0, kAXSubroleAttribute) == "AXTabPanel"
      && classes($0).contains("p-about_modal__tab_panel")
      && classes($0).contains("c-tabs__tab_panel--active")
  }
  try require(panels.count == 1, "Members panel is unavailable or ambiguous")
  let lists = try tree(dialog).filter {
    role($0.element) == "AXList" && label($0.element) == "Members in channel"
  }
  try require(lists.count == 1, "Members list is unavailable or ambiguous")
  let list = lists[0].element
  try require(
    try tree(panels[0]).contains { CFEqual($0.element, list) },
    "Members list does not belong to the selected panel")
  let close = try tree(dialog).filter {
    role($0.element) == "AXButton" && label($0.element) == "Close"
  }
  try require(close.count == 1, "Member dialog Close control is unavailable or ambiguous")
  let control = close[0].element
  let parent = attr(control, kAXParentAttribute)
  let direct =
    parent.map {
      CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, dialog)
    } == true && accessibilityChildren(dialog).contains { CFEqual($0, control) }
  try require(
    membersCloseButtonMatches(
      role(control), label(control), classes(control),
      (attr(control, kAXEnabledAttribute) as? Bool) == true, actions(control), direct),
    "Member dialog Close control is not enabled and directly owned; no close requested")
  return MembersCloseScope(
    channel: channel, dialog: dialog, tab: tab, tabLabel: label(tab), panel: panels[0], list: list,
    control: control)
}
func closeMembers(_ workspace: Workspace) throws -> [String: Any] {
  var result: [String: Any] = [
    "operation": "close-members", "pid": workspace.pid,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "wasOpen": NSNull(), "closed": false, "closeAttempted": false,
    "closeMayHaveBeenRequested": false, "dialogMayBeOpen": NSNull(), "channel": NSNull(),
  ]
  func source() throws -> [String: Any] {
    let root = try workspace.root()
    guard let url = attr(root, kAXURLAttribute) as? URL else {
      throw Failure(description: "Current source URL is unavailable")
    }
    return [
      "url": url.absoluteString, "title": label(root),
      "windowId": try windowId(workspace.window, workspace.pid),
    ]
  }
  do {
    let before = try source()
    result["before"] = before
    guard let scope = try membersCloseScope(workspace) else {
      result["wasOpen"] = false
      var observedBefore = before
      observedBefore["dialogPresent"] = false
      result["before"] = observedBefore
      try sampleDesktop("verify-close-members-noop")
      try require(
        try membersCloseScope(workspace) == nil, "Dialog appeared during close-members no-op")
      var after = try source()
      try require(
        NSDictionary(dictionary: before).isEqual(to: after),
        "Source changed during close-members no-op")
      after["dialogPresent"] = false
      result["after"] = after
      result["dialogMayBeOpen"] = false
      result["status"] = "ok"
      result["desktopSamples"] = desktopSamples
      return result
    }
    result["wasOpen"] = true
    var observedBefore = before
    observedBefore["dialogPresent"] = true
    result["before"] = observedBefore
    result["dialogMayBeOpen"] = true
    result["channel"] = scope.channel.receipt
    try require(
      before["url"] as? String == scope.channel.url, "Source changed during member-dialog capture")
    let expectedWindow = before["windowId"] as! Int
    try sampleDesktop("before-close-members")
    try finalWindowInput(
      expectedWindow, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try membersCloseModalState(workspace, scope.dialog) },
      verifyControl: {
        guard let fresh = try membersCloseScope(workspace), scope.sameIdentity(fresh) else {
          throw Failure(description: "Member dialog changed before close; no close requested")
        }
      },
      input: {
        result["closeAttempted"] = true
        result["closeMayHaveBeenRequested"] = true
        try press(scope.control)
      })
    let deadline = Date().addingTimeInterval(4)
    var closed = false
    while Date() < deadline {
      settle()
      try sampleDesktop("verify-close-members")
      let root = try workspace.root()
      guard let url = attr(root, kAXURLAttribute) as? URL else {
        throw Failure(description: "Channel source disappeared after close")
      }
      try require(
        membersCloseChannel(label(root), url, "Details for channel \(scope.channel.name)")
          == scope.channel,
        "Channel changed after member-dialog close; inspect before retrying")
      if try membersCloseScope(workspace) == nil {
        closed = true
        break
      }
    }
    try require(closed, "Member dialog closure is unverified; inspect before retrying")
    var after = try source()
    try require(
      after["url"] as? String == scope.channel.url && after["windowId"] as? Int == expectedWindow,
      "Channel/window changed after member-dialog close")
    after["dialogPresent"] = false
    result["after"] = after
    result["verification"] = [
      "dialogMatched": true, "membersTabVerified": true,
      "memberListVerified": true, "controlVerified": true,
    ]
    result["closed"] = true
    result["dialogMayBeOpen"] = false
    result["status"] = "ok"
  } catch {
    result["status"] = "stopped"
    result["error"] = String(describing: error)
    result["next"] = "Inspect the current Slack view before another request; no close is replayed."
    if let observation = afterErrorObservation() { result["observation"] = observation }
  }
  result["desktopSamples"] = desktopSamples
  return result
}
// Closes the open thread side pane through its verified Close button. With no
// thread pane open this is a verified no-op; no other pane is ever closed.
func closeThread(_ workspace: Workspace) throws -> [String: Any] {
  var attempted = false
  var result: [String: Any] = [
    "operation": "close-thread", "pid": workspace.pid,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
  ]
  do {
    let root = try workspace.root()
    try require(
      try queryFields(root).isEmpty, "Search picker must be closed before closing a thread")
    guard let scope = try threadPaneScope(root) else {
      result["wasOpen"] = false
      result["closed"] = false
      result["thread"] = NSNull()
      result["status"] = "ok"
      result["closeAttempted"] = false
      return result
    }
    result["wasOpen"] = true
    if let view = try? threadView(root) {
      result["thread"] = [
        "conversationId": view.header.conversationId, "rootTS": view.header.messageTS,
      ]
    } else {
      result["thread"] = NSNull()
    }
    let control = try threadCloseControl(scope)
    let window = try windowId(workspace.window, workspace.pid)
    try requireNoModal(workspace.window)
    try sampleDesktop("before-close-thread")
    try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      verifyControl: {
        guard let fresh = try threadPaneScope(workspace.root()), CFEqual(fresh, scope),
          CFEqual(try threadCloseControl(fresh), control)
        else { throw Failure(description: "Thread pane changed before close; input withheld") }
      },
      input: {
        attempted = true
        try press(control)
      })
    let deadline = Date().addingTimeInterval(4)
    var closed = false
    while Date() < deadline {
      settle()
      try sampleDesktop("verify-close-thread")
      if try threadPaneScope(workspace.root()) == nil {
        closed = true
        break
      }
    }
    try require(closed, "Thread pane closure is unverified; inspect before retrying")
    result["closed"] = true
    result["status"] = "ok"
  } catch {
    result["status"] = "stopped"
    result["error"] = String(describing: error)
    result["next"] = "Inspect the current Slack view before another request; no close is replayed."
    if let observation = afterErrorObservation() { result["observation"] = observation }
  }
  result["closeAttempted"] = attempted
  return result
}
func readThread(
  _ requested: MessageLink, _ workspace: Workspace, _ running: NSRunningApplication? = nil
) throws -> [String: Any] {
  var root = try workspace.root()
  if try !queryFields(root).isEmpty {
    let id = try windowId(workspace.window, workspace.pid)
    try backgroundKey(53, "\u{1B}", root, workspace.window, id, workspace.pid)
    root = try workspace.root()
    try require(try queryFields(root).isEmpty, "Query overlay remains open; thread input withheld")
    recoverySteps.append("Closed existing Search picker before reading thread")
  }
  if let current = try threadView(root), current.matches(requested), current.loaded {
    recoverySteps.append("Requested thread already open; reused exposed replies")
    return current.target(requested, root)
  }
  var sources = try threadSources(root, requested)
  // A reply's thread is opened from its root message's row.
  let anchor =
    try requested.threadTS.flatMap { thread in
      thread == requested.messageTS
        ? nil : try MessageLink("\(requested.conversationId):\(thread)")
    } ?? requested
  var locator = requested
  if sources.isEmpty {
    try exposeThreadSource(requested, workspace)
    root = try workspace.root()
    locator = anchor
    sources = try threadSources(root, anchor)
  }
  // Slack has moved on from the view that listed the message. Open the
  // reference's own conversation by its exact ID, verified as for a media
  // source, then scroll toward the thread root within the same bound.
  if sources.isEmpty, let running {
    let deadline = Date().addingTimeInterval(30)
    try navigateMediaSourceConversation(
      MediaSourceRequest(
        workspace: workspace.context,
        messageRef: "\(anchor.conversationId):\(anchor.messageTS)"),
      workspace, running, deadline)
    recoverySteps.append("Opened the referenced conversation to reach the thread root")
    try exposeThreadSource(anchor, workspace)
    root = try workspace.root()
    sources = try threadSources(root, anchor)
  }
  try require(
    sources.count == 1,
    "Thread root is not uniquely exposed: its conversation was opened where possible and bounded scrolling did not reach it. Rerun the search or read that listed the message, then follow its read-thread reference straight away"
  )
  let source = sources[0]
  let buttons = try threadReplyControls(source.container)
  try require(
    buttons.count == 1,
    "This exposed message has no unique reply control. No thread was opened; inspect the message or locate its root"
  )
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-open-thread")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) },
    verifyControl: {
      let fresh = try threadSources(workspace.root(), locator)
      try require(
        fresh.count == 1 && CFEqual(fresh[0].container, source.container),
        "Message changed before thread opening; input withheld")
      try verifyThreadReplyControl(buttons[0], try threadReplyControls(fresh[0].container))
    }, input: { try press(buttons[0]) })
  // A thread opened straight after navigation can take longer to load replies.
  let deadline = Date().addingTimeInterval(12)
  var lastReason = "Matching thread content is not loaded"
  while Date() < deadline {
    settle()
    try sampleDesktop("verify-thread")
    root = try workspace.root()
    do {
      if let view = try threadView(root), view.matches(requested), view.loaded {
        try require(
          source.link.threadTS == nil || source.link.threadTS == view.header.messageTS,
          "Opened thread differs from the source message's thread_ts")
        return view.target(requested, root)
      }
    } catch {
      // React can update the header before replacing the old message rows.
      // Observe again; never repeat the opener or accept mismatched rows.
      lastReason = String(describing: error)
    }
  }
  throw Failure(
    description:
      "Thread opening attempted once, but matching replies were not verified: \(lastReason). Inspect before another command"
  )
}
// Metadata inspection adds no input primitive. Two independently captured scopes
// let the wrapper reject changing attachment identities/order before resolving a ref.
func validMediaReference(_ value: String) -> Bool {
  value.utf8.count <= 256
    && value.range(
      of: #"^(?:F[A-Z0-9]+|[CDG][A-Z0-9]+:[0-9]{10}\.[0-9]{6}/m[1-9][0-9]{0,3})$"#,
      options: .regularExpression) != nil
    && !value.contains("\n") && !value.contains("\r")
}
func mediaObservation(_ workspace: Workspace, onNode: ((Int, AXUIElement) -> Void)? = nil) throws
  -> [String: Any]
{
  try requireNoModal(workspace.window)
  let root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Close the Search picker before reading media")
  let before = identity(root)
  let thread = try threadView(root)
  let content = try contentSnapshot(root, onNode: onNode)
  let fresh = try workspace.root()
  let after = identity(fresh)
  try require(
    before["url"] as? String == after["url"] as? String
      && before["title"] as? String == after["title"] as? String,
    "Media source view changed during capture; reread the source for fresh references")
  try require(try queryFields(fresh).isEmpty, "Search picker appeared during media capture")
  let freshThread = try threadView(fresh)
  try require(
    thread?.header.url == freshThread?.header.url
      && thread?.messageTimestamps == freshThread?.messageTimestamps,
    "Thread source changed during media capture; reread the source for fresh references")
  var observation: [String: Any] = ["before": before, "after": after, "content": content]
  if let thread {
    observation["threadTarget"] = thread.target(thread.header, fresh)
  }
  return observation
}

// A retained AX candidate is selected only after the wrapper verifies the media
// reference/cache. The token cannot express an arbitrary AX action or selector.
func existingTranscriptLabel(_ value: String) -> Bool {
  ["View transcript", "View transcript for this audio", "View transcript for this video"].contains(
    value)
}
// Audio transcripts are inline popovers. Their ownership is structural: the
// transcript and opener share a wrapper directly inside one retained player.
func audioTranscriptBindingRows(
  _ rows: [[String: Any]], _ mediaIndex: Int,
  controlIndex: Int? = nil, panelIndex: Int? = nil
) -> [String: Int]? {
  let indexed = Dictionary(
    uniqueKeysWithValues: rows.compactMap { row -> (Int, [String: Any])? in
      guard let index = row["index"] as? Int else { return nil }
      return (index, row)
    })
  func has(_ row: [String: Any], _ value: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(value)
  }
  func children(_ index: Int) -> [[String: Any]] { rows.filter { $0["parent"] as? Int == index } }
  guard let media = indexed[mediaIndex], has(media, "p-search_file--audio-player") else {
    return nil
  }
  var matches: [[String: Int]] = []
  for wrapper in children(mediaIndex)
  where wrapper["role"] as? String == "AXGroup" && wrapper["classes"] as? [String] == ["active"] {
    guard let wrapperIndex = wrapper["index"] as? Int else { continue }
    let controls = children(wrapperIndex).filter {
      $0["role"] as? String == "AXButton" && existingTranscriptLabel($0["label"] as? String ?? "")
    }
    let popovers = children(wrapperIndex).filter {
      $0["role"] as? String == "AXGroup" && has($0, "ReactModal__Content")
        && has($0, "ReactModal__Content--after-open") && has($0, "c-popover__content")
        && has($0, "popover")
    }
    guard controls.count == 1, popovers.count == 1,
      let control = controls[0]["index"] as? Int, let popover = popovers[0]["index"] as? Int,
      controlIndex == nil || controlIndex == control
    else { continue }
    let panels = children(popover).filter {
      $0["role"] as? String == "AXGroup" && has($0, "p-media_transcript")
        && has($0, "p-media_transcript--popover")
    }
    guard panels.count == 1, let panel = panels[0]["index"] as? Int,
      panelIndex == nil || panelIndex == panel
    else { continue }
    matches.append([
      "mediaIndex": mediaIndex, "wrapperIndex": wrapperIndex, "controlIndex": control,
      "popoverIndex": popover, "panelIndex": panel,
    ])
  }
  return matches.count == 1 ? matches[0] : nil
}

struct TranscriptVideoLayout {
  let mediaIndex: Int
  let overlayIndex: Int
  let omitted: Set<Int>
  let fileId: String?
}
func transcriptVideoFileIds(_ rows: [[String: Any]], _ mediaIndex: Int) -> Set<String>? {
  let mediaClasses: Set<String> = [
    "p-message_gallery_image_file", "c-file_gallery_image_file", "p-message_file",
    "c-pillow_file_container", "p-video_message_file", "p-search_file--audio-player",
  ]
  var excluded = Set<Int>()
  var result = Set<String>()
  func match(_ value: String, _ pattern: String) -> String? {
    guard let expression = try? NSRegularExpression(pattern: pattern),
      let match = expression.firstMatch(
        in: value, range: NSRange(value.startIndex..<value.endIndex, in: value)),
      let range = Range(match.range(at: 1), in: value)
    else { return nil }
    return String(value[range])
  }
  for row in transcriptRawSourceRows(rows, mediaIndex) {
    let index = row["index"] as! Int
    let classes = row["classes"] as? [String] ?? []
    if index != mediaIndex
      && ((row["parent"] as? Int).map { excluded.contains($0) } == true
        || !mediaClasses.isDisjoint(with: classes) || classes.contains("c-message_kit__actions")
        || ["AXTextArea", "AXTextField"].contains(row["role"] as? String ?? "")
        || classes.contains(where: {
          $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
            || $0.hasPrefix("p-workspace__input")
        }))
    {
      excluded.insert(index)
      continue
    }
    if let id = row["id"] as? String,
      let fileId = match(id, #"^caption-description-(F[A-Z0-9]+)\z"#)
    {
      result.insert(fileId)
    }
    guard let value = row["url"] as? String else { continue }
    // Foundation is not a WHATWG URL parser. Uncertain syntax must preserve the
    // whole settings subtree, never silently lose an independently known ID.
    guard !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
      !value.contains("\\"), let separator = value.range(of: "://"),
      let url = URLComponents(string: value),
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      url.user == nil, url.password == nil, let host = url.host?.lowercased()
    else { return nil }
    let authority = String(value[separator.upperBound...].prefix { !"/?#".contains($0) })
    guard
      authority.range(
        of: #"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]+)?\z"#, options: .regularExpression)
        != nil,
      !url.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).contains(
        where: {
          let decoded = String($0).removingPercentEncoding
          return decoded == "." || decoded == ".."
        })
    else { return nil }
    guard url.scheme?.lowercased() == "https", host == "slack.com" || host.hasSuffix(".slack.com")
    else { continue }
    let pattern =
      host == "files.slack.com"
      ? #"^/files-(?:pri|tmb)/[TE][A-Z0-9]+-(F[A-Z0-9]+)(?:-[a-zA-Z0-9]+)?/"#
      : #"^/files/U[A-Z0-9]+/(F[A-Z0-9]+)(?:/|\z)"#
    if let fileId = match(url.percentEncodedPath, pattern) { result.insert(fileId) }
  }
  return result
}
// Only the observed neutral settings layouts are interchangeable. Every row
// removed here has its complete shape and values checked; all other source
// metadata, controls and ordering remain part of the source signature.
func transcriptVideoLayouts(_ rows: [[String: Any]]) -> [TranscriptVideoLayout] {
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func children(_ row: [String: Any]) -> [[String: Any]] {
    rows.filter { $0["parent"] as? Int == row["index"] as? Int }
  }
  func has(_ row: [String: Any], _ value: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(value)
  }
  let baseKeys: Set<String> = [
    "index", "parent", "role", "classes", "id", "label", "AXTitle", "AXDescription", "AXValue",
    "AXHelp",
  ]
  func exact(
    _ row: [String: Any], _ role: String, _ classes: [String], _ label: String = "",
    value: String = "", id: String = "", state: String? = nil, plain: Bool = false
  ) -> Bool {
    let keys = state == nil ? baseKeys : baseKeys.union(["stateValue", "selected"])
    return Set(row.keys) == keys && row["role"] as? String == role
      && row["classes"] as? [String] == classes && row["label"] as? String == label
      && row["id"] as? String == id && row["AXValue"] as? String == value
      && row["AXTitle"] as? String == (plain ? "" : label)
      && row["AXDescription"] as? String == (plain ? "" : label)
      && row["AXHelp"] as? String == ""
      && (state == nil
        || (row["stateValue"] as? String == state && row["selected"] as? Bool == false))
  }
  let overlayClasses = [
    "p-video_controls_overlay", "p-video_controls_overlay--design_polish",
    "p-video_controls_overlay--controls",
  ]
  let compactClass = "p-video_controls_overlay--design_polish_compact"
  let buttonClasses = [
    "c-button--focus-visible", "c-button-unstyled", "p-video_controls_overlay__controls__button",
  ]
  var result: [TranscriptVideoLayout] = []
  for overlay in rows {
    guard let mediaIndex = overlay["parent"] as? Int, let media = indexed[mediaIndex],
      media["role"] as? String == "AXGroup", has(media, "p-video_message_file"),
      overlay["role"] as? String == "AXGroup",
      overlay["classes"] as? [String] == overlayClasses
        || overlay["classes"] as? [String] == overlayClasses + [compactClass]
    else { continue }
    let compact = has(overlay, compactClass)
    let outer = children(overlay)
    guard outer.count == 2,
      exact(outer[0], "AXGroup", ["p-video_controls_overlay__controls_container"]),
      outer[1]["role"] as? String == "AXGroup", has(outer[1], "p-video_controls_overlay__corner"),
      children(media).filter({ has($0, "p-video_controls_overlay") }).count == 1
    else { continue }
    let controls = children(outer[0])
    guard controls.count >= 4,
      controls[0]["role"] as? String == "AXGroup", has(controls[0], "p-video_controls_scrubber"),
      controls[1]["role"] as? String == "AXCheckBox",
      has(controls[1], "p-video_controls_overlay__controls__pill"),
      (controls[1]["label"] as? String ?? "").hasPrefix("Play,"),
      controls[1]["stateValue"] as? String == "0", controls[1]["selected"] as? Bool == false,
      controls[2]["role"] as? String == "AXGroup", has(controls[2], "p-media_volume_slider")
    else { continue }
    let tail = Array(controls.dropFirst(3))
    var omitted = Set<Int>()
    if compact {
      guard tail.count == 1,
        exact(
          tail[0], "AXPopUpButton",
          buttonClasses + [
            "p-video_controls_overlay__controls__button--overflow",
            "p-video_controls_overlay__controls__button--size-small",
          ], "Settings", state: ""), children(tail[0]).isEmpty
      else { continue }
      omitted.insert(tail[0]["index"] as! Int)
    } else {
      guard tail.count == 2 || tail.count == 3 else { continue }
      let speed = tail[0]
      let speedId = speed["id"] as? String ?? ""
      let speedText = children(speed)
      guard
        speedId.range(of: #"^playback-speed-[a-z0-9]{8}_button\z"#, options: .regularExpression)
          != nil,
        exact(
          speed, "AXComboBox",
          ["c-select_button", "c-select_button--small", "c-select_button--text-select"],
          "Set playback speed: currently 1×", value: "1x", id: speedId, state: "1x"),
        speedText.count == 1,
        exact(speedText[0], "AXStaticText", [], "1x", value: "1x", plain: true),
        children(speedText[0]).isEmpty
      else { continue }
      omitted.formUnion([speed["index"] as! Int, speedText[0]["index"] as! Int])
      if tail.count == 3 {
        let description = tail[1]
        let descriptionId = description["id"] as? String ?? ""
        let descriptionText = children(description)
        let availability = "Captions are now available for this video."
        guard
          descriptionId.range(
            of: #"^caption-description-F[A-Z0-9]+\z"#, options: .regularExpression)
            != nil,
          exact(description, "AXGroup", ["sr-only"], id: descriptionId),
          descriptionText.count == 1,
          exact(
            descriptionText[0], "AXStaticText", [], availability, value: availability, plain: true),
          children(descriptionText[0]).isEmpty
        else { continue }
        omitted.formUnion([description["index"] as! Int, descriptionText[0]["index"] as! Int])
      }
      let caption = tail.last!
      let checkbox = children(caption)
      guard exact(caption, "AXGroup", []), checkbox.count == 1 else { continue }
      let captionLabel = checkbox[0]["label"] as? String ?? ""
      guard ["Turn on captions", "Turn on captions for this video"].contains(captionLabel),
        exact(
          checkbox[0], "AXCheckBox",
          buttonClasses + ["p-video_controls_overlay__controls__caption"], captionLabel, state: "0"),
        children(checkbox[0]).isEmpty
      else { continue }
      omitted.formUnion([caption["index"] as! Int, checkbox[0]["index"] as! Int])
    }
    guard let fileIds = transcriptVideoFileIds(rows, mediaIndex), fileIds.count <= 1 else {
      continue
    }
    result.append(
      TranscriptVideoLayout(
        mediaIndex: mediaIndex, overlayIndex: overlay["index"] as! Int, omitted: omitted,
        fileId: fileIds.first))
  }
  return result
}
final class TranscriptVideoPins {
  private var identities: [AXIdentity]?
  private var fileIds: [AXIdentity: String] = [:]
  func observe(_ layouts: [TranscriptVideoLayout], _ elements: [Int: AXUIElement]) throws {
    var observed: [AXIdentity] = []
    var seen = Set<AXIdentity>()
    var updates: [AXIdentity: String] = [:]
    for layout in layouts {
      guard let element = elements[layout.mediaIndex] else {
        throw Failure(description: "Video layout identity is unavailable")
      }
      let identity = AXIdentity(element: element)
      try require(seen.insert(identity).inserted, "Video layout identity is ambiguous")
      observed.append(identity)
      if let fileId = layout.fileId {
        try require(
          fileIds[identity] == nil || fileIds[identity] == fileId,
          "Video caption file identity changed; transcript withheld")
        updates[identity] = fileId
      }
    }
    try require(
      identities == nil || identities == observed,
      "Video layout source identity changed; transcript withheld")
    identities = observed
    fileIds.merge(updates) { _, new in new }
  }
}
func transcriptRawSourceRows(_ rows: [[String: Any]], _ rootIndex: Int) -> [[String: Any]] {
  var included = Set([rootIndex])
  return rows.filter { row in
    guard let index = row["index"] as? Int else { return false }
    if index == rootIndex || (row["parent"] as? Int).map({ included.contains($0) }) == true {
      included.insert(index)
      return true
    }
    return false
  }
}
func transcriptControlWithinMedia(_ rows: [[String: Any]], _ mediaIndex: Int, _ controlIndex: Int)
  -> Bool
{
  controlIndex != mediaIndex
    && transcriptRawSourceRows(rows, mediaIndex).contains {
      $0["index"] as? Int == controlIndex
    }
}
func transcriptSearchCardRows(
  _ rows: [[String: Any]], _ rootIndex: Int, _ selectedMediaIndex: Int?
) -> [[String: Any]] {
  let fields: Set<String> = [
    "index", "parent", "role", "classes", "id", "label", "AXTitle", "AXDescription", "AXValue",
    "AXHelp",
  ]
  func emptyGroup(_ row: [String: Any], _ names: [String]) -> Bool {
    Set(row.keys) == fields && row["role"] as? String == "AXGroup"
      && row["classes"] as? [String] == names
      && ["id", "label", "AXTitle", "AXDescription", "AXValue", "AXHelp"].allSatisfy {
        row[$0] as? String == ""
      }
  }
  guard let selectedMediaIndex,
    let root = rows.first(where: { $0["index"] as? Int == rootIndex }),
    emptyGroup(
      root,
      [
        "c-message_kit__actions", "c-message_kit__actions--above",
        "c-search_message__actions_container--ia4",
      ])
  else { return rows }
  let direct = rows.filter { $0["parent"] as? Int == rootIndex }
  let wrappers = direct.filter {
    ($0["classes"] as? [String] ?? []).contains("c-search_message__body--card_clamp")
      || ($0["classes"] as? [String] ?? []).contains("c-search_message__body--card_clipped")
  }
  let expanders = direct.filter { ($0["classes"] as? [String] ?? []).contains("c-search__expand") }
  guard wrappers.count == 1, expanders.count == 1,
    let wrapper = wrappers.first, let wrapperIndex = wrapper["index"] as? Int,
    let button = expanders.first, let buttonIndex = button["index"] as? Int,
    emptyGroup(
      wrapper, ["c-search_message__body--card_clamp", "c-search_message__body--card_clipped"]),
    Set(button.keys) == fields.union(["selected", "stateValue"]),
    button["role"] as? String == "AXButton",
    [
      ["c-button-unstyled", "c-search__expand"],
      ["c-button--focus-visible", "c-button-unstyled", "c-search__expand"],
    ].contains(button["classes"] as? [String] ?? []),
    button["label"] as? String == "... Show more", button["AXTitle"] as? String == "... Show more",
    ["id", "AXDescription", "AXValue", "AXHelp", "stateValue"].allSatisfy({
      button[$0] as? String == ""
    }),
    button["selected"] as? Bool == false,
    !rows.contains(where: { $0["parent"] as? Int == buttonIndex }),
    let position = direct.firstIndex(where: { $0["index"] as? Int == wrapperIndex }),
    position > 0, position + 2 < direct.count,
    direct[position - 1]["role"] as? String == "AXGroup",
    direct[position - 1]["classes"] as? [String]
      == ["c-search_message__content_header", "c-search_message__content_header--compact"],
    direct[position + 1]["index"] as? Int == buttonIndex
  else { return rows }
  let videos = direct.dropFirst(position + 2).prefix { row in
    row["role"] as? String == "AXGroup"
      && row["classes"] as? [String] == [
        "p-video_message_file", "p-video_message_file--gallery_v3", "c-search_message__media_item",
      ]
  }
  guard videos.filter({ $0["index"] as? Int == selectedMediaIndex }).count == 1 else { return rows }
  let children = rows.filter { $0["parent"] as? Int == wrapperIndex }
  guard children.count == 1, emptyGroup(children[0], ["p-rich_text_section"]),
    let richIndex = children[0]["index"] as? Int,
    let wrapperOffset = rows.firstIndex(where: { $0["index"] as? Int == wrapperIndex }),
    let buttonOffset = rows.firstIndex(where: { $0["index"] as? Int == buttonIndex }),
    wrapperOffset + 1 < buttonOffset, rows[wrapperOffset + 1]["index"] as? Int == richIndex,
    transcriptRawSourceRows(rows, wrapperIndex).compactMap({ $0["index"] as? Int })
      == rows[wrapperOffset..<buttonOffset].compactMap({ $0["index"] as? Int })
  else { return rows }
  // This complete, known pair only changes the search-card layout. Preserve the
  // entire rich-text subtree, including nested expand controls and every media row.
  return rows.filter { ![wrapperIndex, buttonIndex].contains($0["index"] as? Int ?? -1) }.map {
    row in
    var result = row
    if row["index"] as? Int == richIndex { result["parent"] = rootIndex }
    return result
  }
}
func transcriptSourceRows(
  _ rawRows: [[String: Any]], _ rootIndex: Int, selectedMediaIndex: Int? = nil
) throws -> [[String: Any]] {
  var rows = transcriptSearchCardRows(rawRows, rootIndex, selectedMediaIndex)
  if let selectedMediaIndex, let binding = audioTranscriptBindingRows(rawRows, selectedMediaIndex) {
    var omitted = Set([binding["popoverIndex"]!])
    rows = rawRows.filter { row in
      if let index = row["index"] as? Int,
        index == binding["popoverIndex"]!
          || (row["parent"] as? Int).map({ omitted.contains($0) }) == true
      {
        omitted.insert(index)
        return false
      }
      return true
    }.map { row in
      var result = row
      if row["index"] as? Int == binding["wrapperIndex"]! { result["classes"] = [String]() }
      return result
    }
  }
  var included = Set([rootIndex])
  var selected: [[String: Any]] = []
  for row in rows {
    guard let index = row["index"] as? Int else {
      throw Failure(description: "Invalid source node index")
    }
    if index == rootIndex || (row["parent"] as? Int).map({ included.contains($0) }) == true {
      included.insert(index)
      selected.append(row)
    }
  }
  try require(
    !selected.isEmpty && selected[0]["index"] as? Int == rootIndex,
    "Selected source subtree is unavailable")
  let layouts = transcriptVideoLayouts(selected)
  let omitted = layouts.reduce(into: Set<Int>()) { $0.formUnion($1.omitted) }
  let overlays = Set(layouts.map { $0.overlayIndex })
  selected = selected.filter { !omitted.contains($0["index"] as! Int) }.map { row in
    var result = row
    if overlays.contains(row["index"] as! Int) {
      result["classes"] = (row["classes"] as! [String]).filter {
        $0 != "p-video_controls_overlay--design_polish_compact"
      }
    }
    return result
  }
  let indexes = Dictionary(
    uniqueKeysWithValues: selected.enumerated().map { ($0.element["index"] as! Int, $0.offset) })
  let normalizedRows = try selected.map { row in
    var normalized = row
    let old = row["index"] as! Int
    normalized["index"] = indexes[old]!
    if old == rootIndex {
      normalized["parent"] = NSNull()
    } else {
      guard let parent = row["parent"] as? Int, let relative = indexes[parent] else {
        throw Failure(description: "Selected source ancestry changed")
      }
      normalized["parent"] = relative
    }
    if row["role"] as? String == "AXButton", existingTranscriptLabel(row["label"] as? String ?? "")
    {
      normalized["classes"] = (row["classes"] as? [String] ?? []).filter {
        $0 != "c-button--disabled"
      }
    }
    if (row["classes"] as? [String] ?? []).contains("p-media_volume_slider") {
      normalized["classes"] = (row["classes"] as? [String] ?? []).filter {
        !["p-media_volume_slider--popover", "p-media_volume_slider--vertical"].contains($0)
      }
    }
    for field in ["label", "AXValue", "AXTitle", "AXDescription"] {
      if let value = normalized[field] as? String {
        normalized[field] = value.replacingOccurrences(of: "\u{E000}", with: "")
          .replacingOccurrences(of: "\u{E001}", with: "")
      }
    }
    return normalized
  }
  let byIndex = Dictionary(uniqueKeysWithValues: normalizedRows.map { ($0["index"] as! Int, $0) })
  let parents = Set(normalizedRows.compactMap { $0["parent"] as? Int })
  let plainFields: Set<String> = [
    "index", "parent", "role", "classes", "id", "label",
    "AXTitle", "AXDescription", "AXValue", "AXHelp",
  ]
  func plainLinkText(_ row: [String: Any]) -> Bool {
    guard let index = row["index"] as? Int, let parent = row["parent"] as? Int,
      byIndex[parent]?["role"] as? String == "AXLink", !parents.contains(index),
      row["role"] as? String == "AXStaticText", row["classes"] as? [String] == [],
      let value = row["label"] as? String, row["AXValue"] as? String == value,
      Set(row.keys).isSubset(of: plainFields)
    else { return false }
    return ["id", "AXTitle", "AXDescription", "AXHelp"].allSatisfy { row[$0] as? String == "" }
  }
  // Search highlighting can split a link's anonymous leaf text and remove its
  // marker characters on opening the transcript. Preserve exact joined text,
  // parent link identity/URL, all meaningful attributes and encounter order.
  var merged: [[String: Any]] = []
  for row in normalizedRows {
    if let previous = merged.last, plainLinkText(previous), plainLinkText(row),
      previous["parent"] as? Int == row["parent"] as? Int
    {
      let value = (previous["label"] as! String) + (row["label"] as! String)
      merged[merged.count - 1]["label"] = value
      merged[merged.count - 1]["AXValue"] = value
    } else {
      merged.append(row)
    }
  }
  let mergedIndexes = Dictionary(
    uniqueKeysWithValues: merged.enumerated().map { ($0.element["index"] as! Int, $0.offset) })
  return try merged.map { row in
    var result = row
    result["index"] = mergedIndexes[row["index"] as! Int]!
    if let parent = row["parent"] as? Int {
      guard let relative = mergedIndexes[parent] else {
        throw Failure(description: "Normalized source ancestry changed")
      }
      result["parent"] = relative
    }
    return result
  }
}
func transcriptSourceSignature(
  _ rows: [[String: Any]], _ rootIndex: Int, selectedMediaIndex: Int? = nil
) throws -> Data {
  try JSONSerialization.data(
    withJSONObject: transcriptSourceRows(rows, rootIndex, selectedMediaIndex: selectedMediaIndex),
    options: [.sortedKeys])
}
struct TranscriptCandidate {
  let token: String
  let mediaIndex: Int
  let containerIndex: Int
  let controlIndex: Int
  let media: AXUIElement
  let container: AXUIElement
  let control: AXUIElement
  let signature: Data
  let audio: Bool
  let videoPins: TranscriptVideoPins
  var receipt: [String: Any] {
    [
      "token": token, "mediaIndex": mediaIndex, "containerIndex": containerIndex,
      "controlIndex": controlIndex,
    ]
  }
}
func transcriptCandidates(_ observation: [String: Any], _ elements: [Int: AXUIElement]) throws
  -> [TranscriptCandidate]
{
  guard let content = observation["content"] as? [String: Any],
    let rows = content["nodes"] as? [[String: Any]]
  else {
    throw Failure(description: "Transcript source capture is unavailable")
  }
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func has(_ row: [String: Any], _ value: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(value)
  }
  var result: [TranscriptCandidate] = []
  for row in rows
  where row["role"] as? String == "AXButton"
    && existingTranscriptLabel(row["label"] as? String ?? "")
  {
    guard let controlIndex = row["index"] as? Int else { continue }
    var current = row
    var mediaIndex: Int?
    var containerIndex: Int?
    for _ in 0..<40 {
      guard let parent = current["parent"] as? Int, let next = indexed[parent] else { break }
      if mediaIndex == nil
        && (has(next, "p-video_message_file") || has(next, "p-search_file--audio-player"))
      {
        mediaIndex = parent
      }
      if has(next, "c-message_kit__actions") { containerIndex = parent }
      current = next
    }
    guard let mediaIndex, let containerIndex,
      let media = elements[mediaIndex], let container = elements[containerIndex],
      let control = elements[controlIndex]
    else { continue }
    let mediaRows = try transcriptSourceRows(rows, mediaIndex)
    let buttons = mediaRows.filter { $0["role"] as? String == "AXButton" }
    guard buttons.filter({ existingTranscriptLabel($0["label"] as? String ?? "") }).count == 1,
      !buttons.contains(where: { ($0["label"] as? String ?? "").hasPrefix("Generate transcript") })
    else { continue }
    let playing = try transcriptPlayback(media)
    guard !playing.isEmpty && playing.allSatisfy({ $0["value"] as? String == "0" }) else {
      continue
    }
    let videoPins = TranscriptVideoPins()
    try videoPins.observe(
      transcriptVideoLayouts(transcriptRawSourceRows(rows, containerIndex)), elements)
    result.append(
      TranscriptCandidate(
        token: UUID().uuidString, mediaIndex: mediaIndex, containerIndex: containerIndex,
        controlIndex: controlIndex, media: media, container: container, control: control,
        signature: try transcriptSourceSignature(
          rows, containerIndex, selectedMediaIndex: mediaIndex),
        audio: classes(media).contains("p-search_file--audio-player"), videoPins: videoPins))
  }
  try require(result.count <= 1000, "Transcript control inventory exceeds bounds")
  return result
}
func transcriptPlayback(_ media: AXUIElement) throws -> [[String: Any]] {
  try tree(media).filter {
    role($0.element) == "AXCheckBox"
      && (classes($0.element).contains("c-audio_player_play_button")
        || label($0.element).hasPrefix("Play") || label($0.element).hasPrefix("Pause"))
  }.map { ["label": label($0.element), "value": scalarValue($0.element) as Any? ?? NSNull()] }
}
func emitTranscriptLine(_ value: [String: Any]) throws {
  try emit(value)
  fflush(stdout)
}
func transcriptSelectionToken(_ data: Data, _ allowed: Set<String>) throws -> String {
  try require(
    data.count <= 4096, "Transcript selection exceeds bounds; no transcript input performed")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value.count == 1,
    let token = value["token"] as? String, allowed.contains(token)
  else {
    throw Failure(
      description: "Transcript selection was cancelled or unverified; no transcript input performed"
    )
  }
  return token
}
func transcriptControlActive(_ controlClasses: [String], _ enabled: Bool?) -> Bool {
  controlClasses.contains("c-button--disabled") && enabled == false
}
func transcriptSelection(_ candidates: [TranscriptCandidate]) throws -> TranscriptCandidate {
  let deadline = Date().addingTimeInterval(20)
  var data = Data()
  while Date() < deadline {
    axPause(until: Date().addingTimeInterval(0.01))
    try require(!interrupted, "Transcript selection was cancelled; no transcript input performed")
    var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    let ready = poll(&descriptor, 1, 100)
    try require(ready >= 0 || errno == EINTR, "Transcript selection input failed")
    if ready <= 0 { continue }
    var byte: UInt8 = 0
    let count = read(STDIN_FILENO, &byte, 1)
    try require(
      count > 0, "Transcript selection closed before verification; no transcript input performed")
    if byte == 10 {
      let token = try transcriptSelectionToken(data, Set(candidates.map { $0.token }))
      return candidates.first { $0.token == token }!
    }
    data.append(byte)
    try require(
      data.count <= 4096, "Transcript selection exceeds bounds; no transcript input performed")
  }
  throw Failure(description: "Transcript selection timed out; no transcript input performed")
}
func transcriptPanels(_ root: AXUIElement) throws -> [AXUIElement] {
  try tree(root).filter { classes($0.element).contains("p-media_transcript") }.map { $0.element }
}
func verifyAudioTranscriptBinding(
  _ panel: AXUIElement, _ media: AXUIElement, _ control: AXUIElement
) throws {
  var panelIndex: Int?
  var controlIndex: Int?
  let capture = try contentSnapshot(
    media,
    onNode: { index, element in
      if CFEqual(element, panel) { panelIndex = index }
      if CFEqual(element, control) { controlIndex = index }
    })
  let rows = capture["nodes"] as! [[String: Any]]
  try require(
    panelIndex != nil && controlIndex != nil
      && audioTranscriptBindingRows(rows, 0, controlIndex: controlIndex, panelIndex: panelIndex)
        != nil,
    "Audio transcript is not inside the selected player's exact opener scope")
}
func verifiedTranscriptPanel(_ panel: AXUIElement, _ selected: TranscriptCandidate) throws
  -> [String: Any]
{
  let controlClasses = classes(selected.control)
  let enabled = attr(selected.control, kAXEnabledAttribute) as? Bool
  if selected.audio {
    try require(
      enabled == true && !controlClasses.contains("c-button--disabled"),
      "Audio transcript opener state changed")
    try verifyAudioTranscriptBinding(panel, selected.media, selected.control)
  } else {
    try require(
      !classes(panel).contains("p-media_transcript--popover")
        && transcriptControlActive(controlClasses, enabled),
      "Opened panel is not bound to the selected transcript control")
  }
  return [
    "mode": selected.audio ? "audio-popover" : "video-active-control", "enabled": enabled!,
    "classes": controlClasses, "verified": true,
  ]
}
func audioTranscriptCloseIndex(_ rows: [[String: Any]], _ panelIndex: Int) -> Int? {
  guard let panel = rows.first(where: { $0["index"] as? Int == panelIndex }),
    (panel["classes"] as? [String] ?? []).contains("p-media_transcript--popover")
  else { return nil }
  var parent = panelIndex
  for requiredClass in [
    "c-scrollbar__hider", "p-media_transcript__scrollable", "p-media_transcript__action_buttons",
  ] {
    let children = rows.filter {
      $0["parent"] as? Int == parent && $0["role"] as? String == "AXGroup"
        && ($0["classes"] as? [String] ?? []).contains(requiredClass)
    }
    guard children.count == 1, let index = children[0]["index"] as? Int else { return nil }
    parent = index
  }
  let buttons = rows.filter {
    $0["parent"] as? Int == parent && $0["role"] as? String == "AXButton"
      && $0["label"] as? String == "Close transcript"
      && ($0["classes"] as? [String] ?? []).contains("p-media_transcript__close_button")
  }
  return buttons.count == 1 ? buttons[0]["index"] as? Int : nil
}
func closeAudioTranscript(_ panel: AXUIElement, _ workspace: Workspace) throws {
  guard
    let media = ancestor(panel, matching: { classes($0).contains("p-search_file--audio-player") })
  else {
    throw Failure(description: "Existing audio transcript has no verified player scope")
  }
  let controls = try tree(media).filter {
    role($0.element) == "AXButton" && existingTranscriptLabel(label($0.element))
  }
  try require(controls.count == 1, "Existing audio transcript opener is ambiguous")
  try verifyAudioTranscriptBinding(panel, media, controls[0].element)
  func closeButton() throws -> AXUIElement {
    var elements: [Int: AXUIElement] = [:]
    let capture = try contentSnapshot(panel, onNode: { elements[$0] = $1 })
    let rows = capture["nodes"] as! [[String: Any]]
    guard let index = audioTranscriptCloseIndex(rows, 0), let button = elements[index] else {
      throw Failure(description: "Audio transcript close control has no unique supported ancestry")
    }
    return button
  }
  let button = try closeButton()
  try requireNoModal(workspace.window)
  let window = try windowId(workspace.window, workspace.pid)
  let panels = try transcriptPanels(workspace.root())
  try require(
    panels.count == 1 && CFEqual(panels[0], panel),
    "Audio transcript changed before close; input withheld")
  try verifyAudioTranscriptBinding(panel, media, controls[0].element)
  try require(
    CFEqual(try closeButton(), button), "Audio transcript close identity changed; input withheld")
  try sampleDesktop("before-verified-audio-transcript-close")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) }, input: { try press(button) })
  let deadline = Date().addingTimeInterval(4)
  while Date() < deadline {
    settle()
    try sampleDesktop("verify-audio-transcript-close")
    if try transcriptPanels(workspace.root()).isEmpty { return }
  }
  throw Failure(
    description: "Audio transcript close attempted once but panel remains; inspect before retry")
}

func closeExistingTranscript(_ workspace: Workspace) throws {
  let panels = try transcriptPanels(workspace.root())
  try require(panels.count <= 1, "Existing transcript panels are ambiguous; no input performed")
  guard let panel = panels.first else { return }
  if classes(panel).contains("p-media_transcript--popover") {
    try closeAudioTranscript(panel, workspace)
    return
  }
  guard
    let pane = ancestor(
      panel,
      matching: {
        string($0, "AXDOMIdentifier") == "transcript-flexpane" && classes($0).contains("p-flexpane")
      })
  else {
    throw Failure(description: "Existing transcript panel has no verified close scope")
  }
  let toolbar = try tree(pane).filter {
    role($0.element) == "AXToolbar" && classes($0.element).contains("p-flexpane_header")
  }
  try require(toolbar.count == 1, "Transcript close toolbar is ambiguous")
  let nodes = try tree(toolbar[0].element)
  try require(
    nodes.contains { role($0.element) == "AXStaticText" && label($0.element) == "Transcript" },
    "Transcript close header is unverified")
  let buttons = nodes.filter {
    role($0.element) == "AXButton" && label($0.element) == "Close"
      && classes($0.element).contains("p-flexpane_header__control")
  }
  try require(buttons.count == 1, "Transcript close control is unavailable or ambiguous")
  try requireNoModal(workspace.window)
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-close-transcript")
  let fresh = try transcriptPanels(workspace.root())
  try require(
    fresh.count == 1 && CFEqual(fresh[0], panel),
    "Transcript panel changed before close; input withheld")
  guard
    let freshPane = ancestor(
      fresh[0],
      matching: {
        string($0, "AXDOMIdentifier") == "transcript-flexpane" && classes($0).contains("p-flexpane")
      }), CFEqual(freshPane, pane)
  else {
    throw Failure(description: "Transcript close scope changed; input withheld")
  }
  let freshToolbars = try tree(freshPane).filter {
    role($0.element) == "AXToolbar" && classes($0.element).contains("p-flexpane_header")
  }
  try require(
    freshToolbars.count == 1 && CFEqual(freshToolbars[0].element, toolbar[0].element),
    "Transcript close toolbar changed; input withheld")
  let freshNodes = try tree(freshToolbars[0].element)
  let freshButtons = freshNodes.filter {
    role($0.element) == "AXButton" && label($0.element) == "Close"
      && classes($0.element).contains("p-flexpane_header__control")
  }
  try require(
    freshButtons.count == 1 && CFEqual(freshButtons[0].element, buttons[0].element)
      && freshNodes.contains {
        role($0.element) == "AXStaticText" && label($0.element) == "Transcript"
      },
    "Transcript close control changed; input withheld")
  try sampleDesktop("before-verified-transcript-close")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) }, input: { try press(buttons[0].element) })
  let deadline = Date().addingTimeInterval(4)
  while Date() < deadline {
    settle()
    try sampleDesktop("verify-transcript-close")
    if try transcriptPanels(workspace.root()).isEmpty { return }
  }
  throw Failure(
    description: "Transcript close attempted once but panel remains; inspect before retry")
}
func verifyTranscriptSource(_ candidate: TranscriptCandidate, _ workspace: Workspace) throws
  -> [[String: Any]]
{
  let root = try workspace.root()
  try requireNoModal(workspace.window)
  try require(try queryFields(root).isEmpty, "Search picker appeared; transcript input withheld")
  let nodes = try tree(root)
  try require(
    nodes.contains { CFEqual($0.element, candidate.container) }
      && nodes.contains { CFEqual($0.element, candidate.media) }
      && nodes.contains { CFEqual($0.element, candidate.control) },
    "Selected transcript source identity disappeared")
  var mediaIndex: Int?
  var controlIndex: Int?
  var sourceElements: [Int: AXUIElement] = [:]
  let source = try contentSnapshot(
    candidate.container,
    onNode: { index, element in
      if CFEqual(element, candidate.media) { mediaIndex = index }
      if CFEqual(element, candidate.control) { controlIndex = index }
      sourceElements[index] = element
    })
  try require(mediaIndex != nil, "Selected media ancestry changed; transcript withheld")
  let rows = source["nodes"] as! [[String: Any]]
  try require(
    controlIndex != nil && transcriptControlWithinMedia(rows, mediaIndex!, controlIndex!),
    "Selected transcript control left its retained media ancestry; transcript withheld")
  try require(
    try transcriptSourceSignature(rows, 0, selectedMediaIndex: mediaIndex) == candidate.signature,
    "Selected message/media identity or order changed; transcript withheld. Inspect current state before another command"
  )
  try require(
    role(candidate.control) == "AXButton" && existingTranscriptLabel(label(candidate.control)),
    "Selected transcript control changed")
  try candidate.videoPins.observe(transcriptVideoLayouts(rows), sourceElements)
  let playback = try transcriptPlayback(candidate.media)
  try require(
    !playback.isEmpty && playback.allSatisfy { $0["value"] as? String == "0" },
    "Selected media is playing or playback state is unknown; transcript withheld. Inspect current state before another command"
  )
  return playback
}
struct TranscriptSegment: Equatable {
  let timestamp: String
  let seconds: Int
  let text: String
  let textIndex: Int
  var edge: [String: Any] { ["timestamp": timestamp, "text": text] }
  static func == (left: TranscriptSegment, right: TranscriptSegment) -> Bool {
    left.seconds == right.seconds && left.textIndex == right.textIndex
      && left.timestamp.utf8.elementsEqual(right.timestamp.utf8)
      && left.text.utf8.elementsEqual(right.text.utf8)
  }
}
func transcriptTimestampSeconds(_ value: String) -> Int? {
  guard value.count <= 256 else { return nil }
  let safeMaximum = 9_007_199_254_740_991
  let clock = value.split(separator: ":", omittingEmptySubsequences: false)
  if clock.count == 2 || clock.count == 3 {
    guard clock.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
      clock.last!.count == 2, clock[clock.count - 2].count <= 2,
      let seconds = Int(clock.last!), seconds < 60,
      let minutes = Int(clock[clock.count - 2]), clock.count == 2 || minutes < 60,
      let hours = clock.count == 3 ? Int(clock[0]) : 0,
      hours <= safeMaximum / 3600
    else { return nil }
    let total = hours * 3600 + minutes * 60 + seconds
    return total <= safeMaximum ? total : nil
  }
  let expression = try! NSRegularExpression(pattern: #"([0-9]+) (hours?|minutes?|seconds?)"#)
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  let matches = expression.matches(in: value, range: range)
  guard !matches.isEmpty else { return nil }
  let remainder = expression.stringByReplacingMatches(in: value, range: range, withTemplate: "")
  guard remainder.allSatisfy({ $0 == "," || $0.isWhitespace }) else { return nil }
  var total = 0
  var previous = Int.max
  for match in matches {
    guard let numberRange = Range(match.range(at: 1), in: value),
      let unitRange = Range(match.range(at: 2), in: value),
      let number = Int(value[numberRange])
    else { return nil }
    let unit = value[unitRange]
    let factor = unit.hasPrefix("hour") ? 3600 : unit.hasPrefix("minute") ? 60 : 1
    guard factor < previous, number <= (safeMaximum - total) / factor else { return nil }
    total += number * factor
    previous = factor
  }
  return total
}
let unavailableTranscriptMessage =
  "Slack reports that no transcript is available for this attachment. Use read-media with the same reference, or choose another attachment with an existing transcript. No transcript was generated."
func unavailableTranscriptPanel(_ rows: [[String: Any]], audio: Bool) -> Bool {
  guard !audio, rows.count == 10 else { return false }
  let roles = [
    "AXGroup", "AXGroup", "AXStaticText", "AXGroup", "AXGroup", "AXGroup",
    "AXStaticText", "AXButton", "AXStaticText", "AXButton",
  ]
  let parents: [Int?] = [nil, 0, 1, 0, 0, 4, 5, 5, 5, 5]
  let classes = [
    ["p-flexpane_body", "p-media_transcript"], ["p-media_transcript__scrollable"], [],
    ["c-scrollbar__bar"], ["p-media_transcript__footer", "p-media_transcript__footer-flexpane"],
    ["p-media_transcript__footer_content"], [], ["c-link--button"], [], ["c-link--button"],
  ]
  let labels = [
    "", "", "Unfortunately, Slack can’t provide a transcript of this message.", "", "", "",
    "Not what you expected? ", "Give feedback", " or ", "change language",
  ]
  let fields: Set<String> = [
    "index", "parent", "role", "classes", "id", "label", "AXTitle", "AXDescription", "AXValue",
    "AXHelp",
  ]
  for (index, row) in rows.enumerated() {
    let button = roles[index] == "AXButton"
    guard Set(row.keys) == (button ? fields.union(["selected", "stateValue"]) : fields),
      row["index"] as? Int == index,
      parents[index] == nil ? row["parent"] is NSNull : row["parent"] as? Int == parents[index],
      row["role"] as? String == roles[index], row["classes"] as? [String] == classes[index],
      row["label"] as? String == labels[index],
      row["AXTitle"] as? String == (button ? labels[index] : ""),
      row["AXValue"] as? String == (roles[index] == "AXStaticText" ? labels[index] : ""),
      ["id", "AXDescription", "AXHelp"].allSatisfy({ row[$0] as? String == "" }),
      !button || (row["selected"] as? Bool == false && row["stateValue"] as? String == "")
    else { return false }
  }
  return true
}
func requireExistingTranscript(_ rows: [[String: Any]], audio: Bool) throws {
  try require(!unavailableTranscriptPanel(rows, audio: audio), unavailableTranscriptMessage)
}
// This is a structural action guard, not a recursive text scraper. The wrapper
// independently parses each accepted page before exposing any transcript text.
func transcriptSegments(_ rows: [[String: Any]], audio: Bool) throws -> [TranscriptSegment] {
  func has(_ row: [String: Any], _ value: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(value)
  }
  func children(_ row: [String: Any]) -> [[String: Any]] {
    rows.filter { $0["parent"] as? Int == row["index"] as? Int }
  }
  func isSegment(_ row: [String: Any]) -> Bool {
    has(row, "p-media_transcript__timestamp") || has(row, "p-media_transcript__text")
  }
  var seen = Set<Int>()
  for (position, row) in rows.enumerated() {
    try require(
      row["index"] as? Int == position
        && (position == 0
          ? row["parent"] is NSNull : (row["parent"] as? Int).map { seen.contains($0) } == true),
      "Transcript ancestry is incomplete or ambiguous")
    seen.insert(position)
  }
  guard let root = rows.first else { throw Failure(description: "Transcript panel is empty") }
  try require(
    root["role"] as? String == "AXGroup" && has(root, "p-media_transcript")
      && has(root, "p-media_transcript--popover") == audio
      && rows.filter({ has($0, "p-media_transcript") }).count == 1
      && !rows.contains(where: {
        ["AXTextArea", "AXTextField"].contains($0["role"] as? String ?? "")
      }),
    "Transcript panel structure does not match the selected media")
  try requireExistingTranscript(rows, audio: audio)
  let direct = children(root)
  let hiders = rows.filter { has($0, "c-scrollbar__hider") }
  try require(hiders.count <= 1, "Transcript scroll containers are ambiguous")
  var ordered = direct
  if let hider = hiders.first {
    try require(
      hider["role"] as? String == "AXGroup" && hider["parent"] as? Int == 0
        && !direct.contains(where: isSegment), "Transcript segment ancestry is mixed")
    if audio {
      try require(
        (direct.count == 2 || direct.count == 3)
          && direct[0]["index"] as? Int == hider["index"] as? Int
          && direct.last?["role"] as? String == "AXGroup"
          && has(direct.last!, "p-media_transcript__footer")
          && (direct.count == 2
            || (direct[1]["role"] as? String == "AXGroup"
              && has(direct[1], "c-scrollbar__bar") && children(direct[1]).isEmpty)),
        "Audio transcript outer structure is unsupported")
      let containers = rows.filter { has($0, "p-media_transcript__scrollable") }
      let nested = children(hider)
      try require(
        containers.count == 1 && nested.count == 1 && nested[0]["role"] as? String == "AXGroup"
          && nested[0]["index"] as? Int == containers[0]["index"] as? Int,
        "Audio transcript scrollable ancestry is unsupported")
      let inner = children(containers[0])
      try require(inner.count >= 5, "Audio transcript header or segments are incomplete")
      let controls = children(inner[0])
      try require(
        inner[0]["role"] as? String == "AXGroup"
          && has(inner[0], "p-media_transcript__action_buttons")
          && controls.count == 2
          && controls.allSatisfy({ $0["role"] as? String == "AXButton" && children($0).isEmpty })
          && has(controls[0], "p-media_transcript__copy_button")
          && controls[0]["label"] as? String == "Copy"
          && has(controls[1], "p-media_transcript__close_button")
          && controls[1]["label"] as? String == "Close transcript",
        "Audio transcript header controls are unsupported")
      func plainText(_ row: [String: Any]) -> Bool {
        row["role"] as? String == "AXStaticText" && row["classes"] as? [String] == []
          && children(row).isEmpty
      }
      let heading = children(inner[1])
      let metadata = children(inner[2])
      try require(
        inner[1]["role"] as? String == "AXHeading"
          && inner[1]["label"] as? String == "Transcript (auto-generated)"
          && heading.count == 1 && plainText(heading[0])
          && heading[0]["label"] as? String == inner[1]["label"] as? String
          && inner[2]["role"] as? String == "AXGroup" && has(inner[2], "caption")
          && has(inner[2], "sk_foreground_max_solid")
          && metadata.count == 4 && metadata.allSatisfy(plainText),
        "Audio transcript metadata header is unsupported")
      let segments = Array(inner.dropFirst(3))
      try require(
        segments.allSatisfy(isSegment), "Audio transcript segment wrappers are unsupported")
      ordered = segments + Array(direct.dropFirst())
    } else {
      let nested = children(hider)
      try require(
        !nested.isEmpty && nested.allSatisfy(isSegment),
        "Video transcript scroll ancestry is unsupported")
      ordered = direct.flatMap { $0["index"] as? Int == hider["index"] as? Int ? nested : [$0] }
    }
  } else {
    try require(!audio, "Audio transcript scroll container is unavailable")
  }
  var pending: (String, Int)?
  var result: [TranscriptSegment] = []
  var footerSeen = false
  var segmentIndexes = Set<Int>()
  for row in ordered {
    if has(row, "p-media_transcript__timestamp") {
      let timestamp = (row["label"] as? String ?? "").trimmingCharacters(
        in: .whitespacesAndNewlines)
      guard pending == nil, !footerSeen, row["role"] as? String == "AXButton",
        let seconds = transcriptTimestampSeconds(timestamp), seconds >= (result.last?.seconds ?? -1)
      else {
        throw Failure(
          description: "Transcript timestamps are unpaired, unsupported or out of order")
      }
      pending = (timestamp, seconds)
      segmentIndexes.insert(row["index"] as! Int)
    } else if has(row, "p-media_transcript__text") {
      let text = (row["label"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard let pair = pending, !footerSeen, row["role"] as? String == "AXButton", !text.isEmpty
      else {
        throw Failure(description: "Transcript text is unpaired or unavailable")
      }
      result.append(
        TranscriptSegment(
          timestamp: pair.0, seconds: pair.1, text: text, textIndex: row["index"] as! Int))
      pending = nil
      segmentIndexes.insert(row["index"] as! Int)
    } else {
      try require(
        pending == nil && row["role"] as? String == "AXGroup"
          && (has(row, "c-scrollbar__bar") || has(row, "p-media_transcript__footer")),
        "Transcript panel contains unsupported segment structure")
      if has(row, "p-media_transcript__footer") { footerSeen = true }
    }
  }
  try require(
    pending == nil && !result.isEmpty
      && Set(rows.filter(isSegment).map { $0["index"] as! Int }) == segmentIndexes,
    "Transcript segments are incomplete or have unsupported ancestry")
  return result
}
struct TranscriptGroup: Equatable {
  let seconds: Int
  var texts: [String]
  static func == (left: TranscriptGroup, right: TranscriptGroup) -> Bool {
    left.seconds == right.seconds && left.texts.count == right.texts.count
      && zip(left.texts, right.texts).allSatisfy { $0.utf8.elementsEqual($1.utf8) }
  }
}
func transcriptGroups(_ segments: [TranscriptSegment]) throws -> [TranscriptGroup] {
  try require(!segments.isEmpty, "Transcript page contains no segments")
  var result: [TranscriptGroup] = []
  for segment in segments {
    try require(
      segment.seconds >= 0 && segment.seconds >= (result.last?.seconds ?? -1),
      "Transcript page order changed")
    if result.last?.seconds == segment.seconds {
      result[result.count - 1].texts.append(segment.text)
    } else {
      result.append(TranscriptGroup(seconds: segment.seconds, texts: [segment.text]))
    }
  }
  return result
}
func transcriptPageProgress(_ previous: [TranscriptSegment], _ observed: [TranscriptSegment]) throws
  -> String
{
  let before = try transcriptGroups(previous)
  let after = try transcriptGroups(observed)
  guard let offset = before.firstIndex(where: { $0.seconds == after[0].seconds }) else {
    throw Failure(description: "Transcript pages have no verified forward overlap")
  }
  let overlap = Array(before.dropFirst(offset))
  try require(
    after.count >= overlap.count && Array(after.prefix(overlap.count)) == overlap,
    "Transcript page overlap changed, was shortened or skipped the previous final segment group")
  return after.count == overlap.count ? "no-progress" : "advanced"
}
struct TranscriptCapture {
  let content: [String: Any]
  let segments: [TranscriptSegment]
  let edge: AXUIElement
  let signature: Data
}
func transcriptCapture(_ panel: AXUIElement, audio: Bool) throws -> TranscriptCapture {
  var elements: [Int: AXUIElement] = [:]
  let content = try contentSnapshot(panel, onNode: { elements[$0] = $1 })
  let rows = content["nodes"] as! [[String: Any]]
  let segments = try transcriptSegments(rows, audio: audio)
  return TranscriptCapture(
    content: content, segments: segments, edge: elements[segments.last!.textIndex]!,
    signature: try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]))
}
func requireTranscriptBudget(_ deadline: Date) throws {
  try require(
    Date() < deadline,
    "Transcript collection reached its 60-second budget; prior verified pages retained")
}
func advanceTranscriptPage(
  _ previous: TranscriptCapture, _ panel: AXUIElement, _ selected: TranscriptCandidate,
  _ workspace: Workspace, _ playbackBefore: [[String: Any]], _ deadline: Date
) throws -> (TranscriptCapture, [String: Any], [[String: Any]], String) {
  try requireTranscriptBudget(deadline)
  let window = try windowId(workspace.window, workspace.pid)
  let panels = try transcriptPanels(workspace.root())
  try require(
    panels.count == 1 && CFEqual(panels[0], panel), "Transcript panel changed before paging")
  _ = try verifiedTranscriptPanel(panel, selected)
  let playback = try verifyTranscriptSource(selected, workspace)
  try require(
    NSDictionary(dictionary: ["values": playbackBefore]).isEqual(to: ["values": playback]),
    "Playback changed before transcript paging")
  let fresh = try transcriptCapture(panel, audio: selected.audio)
  try require(
    fresh.signature == previous.signature && CFEqual(fresh.edge, previous.edge),
    "Transcript page or edge identity changed before scrolling; no scroll posted")
  try require(
    actions(fresh.edge).contains("AXScrollToVisible"),
    "Transcript edge does not expose background scrolling; prior verified pages retained")
  try requireTranscriptBudget(deadline)
  try sampleDesktop("immediately-before-transcript-scroll")
  // This scroll action never activates the timestamp/text button's AXPress.
  try require(
    try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      input: { () throws -> AXError in
        try requireTranscriptBudget(deadline)
        return try interactionAXAction(fresh.edge, "AXScrollToVisible" as CFString)
      }) == .success,
    "Transcript edge did not accept background scrolling; no input replayed")
  let settleDeadline = min(deadline, Date().addingTimeInterval(5))
  var last: TranscriptCapture?
  var accepted: TranscriptCapture?
  var status = "no-progress"
  repeat {
    settle()
    try sampleDesktop("verify-transcript-scroll")
    try requireTranscriptBudget(deadline)
    let observed = try transcriptCapture(panel, audio: selected.audio)
    status = try transcriptPageProgress(previous.segments, observed.segments)
    accepted = last?.signature == observed.signature ? observed : nil
    last = observed
    if accepted != nil && status == "advanced" { break }
  } while Date() < settleDeadline
  guard let accepted else {
    throw Failure(description: "Transcript page did not settle; prior verified pages retained")
  }
  try requireTranscriptBudget(deadline)
  let finalPanels = try transcriptPanels(workspace.root())
  try require(
    finalPanels.count == 1 && CFEqual(finalPanels[0], panel),
    "Transcript panel changed during paging")
  let finalPlayback = try verifyTranscriptSource(selected, workspace)
  try require(
    NSDictionary(dictionary: ["values": playbackBefore]).isEqual(to: ["values": finalPlayback]),
    "Playback changed during transcript paging")
  // Source checks may take time. Recheck the exact accepted page before retaining it.
  let final = try transcriptCapture(panel, audio: selected.audio)
  try require(
    final.signature == accepted.signature && CFEqual(final.edge, accepted.edge),
    "Transcript page changed during verification")
  let activeControl = try verifiedTranscriptPanel(panel, selected)
  try requireTranscriptBudget(deadline)
  try sampleDesktop("after-transcript-page")
  return (final, activeControl, finalPlayback, status)
}
func readExistingTranscript(_ requested: String, _ workspace: Workspace, _ requestedPages: Int = 1)
  throws -> Int
{
  try require((1...10).contains(requestedPages), "Transcript pages must be an integer from 1 to 10")
  let batchDeadline = Date().addingTimeInterval(60)
  let first = try mediaObservation(workspace)
  var elements: [Int: AXUIElement] = [:]
  let second = try mediaObservation(workspace, onNode: { elements[$0] = $1 })
  let candidates = try transcriptCandidates(second, elements)
  try emitTranscriptLine([
    "operation": "read-transcript", "phase": "select", "requested": requested,
    "pid": workspace.pid, "observations": [first, second],
    "candidates": candidates.map { $0.receipt },
  ])
  let selected = try transcriptSelection(candidates)
  // Validate before closing an existing panel too: stale tokens cannot cause input.
  _ = try verifyTranscriptSource(selected, workspace)
  try closeExistingTranscript(workspace)
  let window = try windowId(workspace.window, workspace.pid)
  try require(
    try transcriptPanels(workspace.root()).isEmpty,
    "Transcript panel appeared before opening; input withheld")
  let playbackBefore = try verifyTranscriptSource(selected, workspace)
  try require(
    !classes(selected.control).contains("c-button--disabled"),
    "Selected transcript control remains active; input withheld")
  try sampleDesktop("before-open-existing-transcript")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) }, input: { try press(selected.control) })
  let deadline = Date().addingTimeInterval(8)
  var panel: AXUIElement?
  while Date() < deadline {
    settle()
    try sampleDesktop("verify-open-existing-transcript")
    let panels = try transcriptPanels(workspace.root())
    try require(panels.count <= 1, "Opened transcript is ambiguous; no input replayed")
    if let found = panels.first {
      panel = found
      break
    }
  }
  guard let panel else {
    throw Failure(
      description: "Transcript opening attempted once but no panel verified; inspect before retry")
  }
  _ = try verifiedTranscriptPanel(panel, selected)
  let playbackAfter = try verifyTranscriptSource(selected, workspace)
  try require(
    NSDictionary(dictionary: ["values": playbackBefore]).isEqual(to: ["values": playbackAfter]),
    "Playback changed during transcript opening; transcript withheld")
  let content = try contentSnapshot(panel)
  settle()
  let panels = try transcriptPanels(workspace.root())
  try require(
    panels.count == 1 && CFEqual(panels[0], panel), "Transcript panel changed during capture")
  var finalElements: [Int: AXUIElement] = [:]
  let finalContent = try contentSnapshot(panel, onNode: { finalElements[$0] = $1 })
  try require(
    try transcriptSourceSignature(content["nodes"] as! [[String: Any]], 0)
      == transcriptSourceSignature(finalContent["nodes"] as! [[String: Any]], 0),
    "Transcript content changed during capture; no partial transcript returned")
  let finalPlayback = try verifyTranscriptSource(selected, workspace)
  try require(
    NSDictionary(dictionary: ["values": playbackBefore]).isEqual(to: ["values": finalPlayback]),
    "Playback changed during transcript capture; transcript withheld")
  let activeControl = try verifiedTranscriptPanel(panel, selected)
  try requireExistingTranscript(finalContent["nodes"] as! [[String: Any]], audio: selected.audio)
  try sampleDesktop("after-transcript-capture")
  let receipt: [String: Any] = [
    "operation": "read-transcript", "phase": "result", "requested": requested,
    "pid": workspace.pid, "selection": selected.receipt,
    "verification": [
      "sourceMatched": true, "panelOpened": true, "playbackUnchanged": true,
      "bindingMode": activeControl["mode"]!,
    ],
    "activeControl": activeControl,
    "transcript": ["content": finalContent, "stable": true],
    "playback": [
      "before": playbackBefore, "afterOpen": playbackAfter, "afterCapture": finalPlayback,
    ],
    "desktop": ["samples": desktopSamples, "scope": "bounded samples, not continuous proof"],
    "recovery": recoverySteps,
  ]
  if requestedPages == 1 {
    try emitTranscriptLine(receipt)
    return 0
  }
  let rows = finalContent["nodes"] as! [[String: Any]]
  let segments = try transcriptSegments(rows, audio: selected.audio)
  var previous = TranscriptCapture(
    content: finalContent, segments: segments, edge: finalElements[segments.last!.textIndex]!,
    signature: try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]))
  func frame(
    _ capture: TranscriptCapture, _ control: [String: Any], _ playback: [[String: Any]],
    _ index: Int, _ status: String, _ edge: [String: Any]?
  ) -> [String: Any] {
    [
      "transcript": ["content": capture.content, "stable": true],
      "verification": [
        "sourceMatched": true, "panelOpened": true, "playbackUnchanged": true,
        "bindingMode": control["mode"]!,
      ], "activeControl": control,
      "playback": ["before": playbackBefore, "afterOpen": playbackAfter, "afterCapture": playback],
      "pagination": [
        "index": index, "status": status, "scrollAttempts": index == 1 ? 0 : 1,
        "edge": edge as Any? ?? NSNull(),
      ],
    ]
  }
  var pages = [frame(previous, activeControl, finalPlayback, 1, "initial", nil)]
  var attemptedPages = 1
  var stopReason = "page-limit"
  var failure: String?
  while pages.count < requestedPages {
    if Date() >= batchDeadline {
      stopReason = "time-limit"
      failure = "Transcript collection reached its 60-second budget; prior verified pages retained"
      break
    }
    attemptedPages += 1
    do {
      let edge = previous.segments.last!.edge
      let (captured, control, playback, status) = try advanceTranscriptPage(
        previous, panel, selected, workspace, playbackBefore, batchDeadline)
      pages.append(frame(captured, control, playback, pages.count + 1, status, edge))
      previous = captured
      if status == "no-progress" {
        stopReason = "no-progress"
        break
      }
    } catch {
      stopReason = Date() >= batchDeadline ? "time-limit" : "error"
      failure = String(describing: error)
      break
    }
  }
  var collection: [String: Any] = [
    "operation": "read-transcript", "phase": "result", "requested": requested,
    "pid": workspace.pid, "selection": selected.receipt,
    "status": failure == nil ? "ok" : "partial", "transcriptPages": pages,
    "transcriptBatch": [
      "requestedPages": requestedPages, "completedPages": pages.count,
      "attemptedPages": attemptedPages, "direction": "down", "stopReason": stopReason,
    ],
    "desktop": ["samples": desktopSamples, "scope": "bounded samples, not continuous proof"],
    "recovery": recoverySteps,
  ]
  if let failure {
    if let observation = afterErrorObservation() { collection["observation"] = observation }
    collection["error"] = failure
    collection["next"] =
      "Inspect the current Slack transcript before resuming; do not replay input blindly"
  }
  try emitTranscriptLine(collection)
  return failure == nil ? 0 : 1
}

func downloadLabel(_ value: String) -> Bool {
  guard value.utf8.count <= 2048,
    !["Download all", "Download all files"].contains(value),
    !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
  else { return false }
  return value == "Download"
    || (value.hasPrefix("Download ")
      && !value.dropFirst("Download ".count).trimmingCharacters(in: .whitespaces).isEmpty)
}
func downloadURLAllowed(_ value: String) -> Bool {
  guard value.utf8.count <= 16384,
    !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
    !value.contains("\\"), let url = URLComponents(string: value),
    url.scheme?.lowercased() == "https", url.host?.lowercased() == "files.slack.com",
    url.user == nil, url.password == nil, url.fragment == nil,
    url.port == nil || url.port == 443,
    value.range(
      of: #"\Ahttps://files\.slack\.com(?::443)?/"#,
      options: [.caseInsensitive, .regularExpression]) != nil,
    url.percentEncodedPath.range(
      of: #"\A/files-(?:pri|tmb)/[TE][A-Z0-9]+-F[A-Z0-9]+(?:-[A-Za-z0-9]+)?/.+\z"#,
      options: .regularExpression) != nil,
    !url.percentEncodedPath.split(separator: "/").contains(where: {
      let decoded = String($0).removingPercentEncoding
      return decoded == "." || decoded == ".."
    })
  else { return false }
  return true
}
func downloadRouteKind(_ value: String, contextId: String? = nil) -> String {
  guard downloadURLAllowed(value), let url = URLComponents(string: value) else {
    return "unknown"
  }
  if url.percentEncodedPath.hasPrefix("/files-tmb/") { return "rendition" }
  // This identifies only Slack's observed file-content Download route. Neither
  // this path shape nor a successful transfer proves equality to uploader bytes.
  guard
    value.range(
      of:
        #"\Ahttps://files\.slack\.com/files-pri/T[A-Z0-9]+-F[A-Z0-9]+/download/[^/?#]+(?:\?origin_team=[TE][A-Z0-9]+)?\z"#,
      options: .regularExpression) != nil,
    url.percentEncodedQuery == nil
      || (contextId != nil && url.percentEncodedQuery == "origin_team=\(contextId!)"),
    let rawPath = value.split(separator: "?", omittingEmptySubsequences: false).first,
    let encodedName = rawPath.split(separator: "/", omittingEmptySubsequences: false).last,
    encodedName.range(of: #"\A[A-Za-z0-9._~!$&'()*+,;=:@%-]+\z"#, options: .regularExpression)
      != nil,
    let name = String(encodedName).removingPercentEncoding,
    !name.isEmpty, ![".", ".."].contains(name),
    !name.contains("/"), !name.contains("\\"),
    !name.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) })
  else { return "unknown" }
  return "file-download"
}
let downloadMediaClasses: Set<String> = [
  "p-message_gallery_image_file", "c-file_gallery_image_file", "p-message_file",
  "c-pillow_file_container", "p-video_message_file", "p-search_file--audio-player",
]
struct DownloadTarget {
  let mediaIndex: Int
  let containerIndex: Int
  let controlIndex: Int
  let url: String
  let routeKind: String
  let label: String
  let playbackRequired: Bool
}
func downloadTargets(_ rows: [[String: Any]], contextId: String? = nil) -> [DownloadTarget] {
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func has(_ row: [String: Any], _ value: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(value)
  }
  var result: [DownloadTarget] = []
  for row in rows {
    guard row["role"] as? String == "AXLink", let label = row["label"] as? String,
      downloadLabel(label), let url = row["url"] as? String, downloadURLAllowed(url)
    else { continue }
    var current = row
    var mediaIndex: Int?
    var headerIndex: Int?
    var containerIndex: Int?
    var excluded = false
    for _ in 0..<40 {
      guard let parent = current["parent"] as? Int, let next = indexed[parent] else { break }
      let classes = next["classes"] as? [String] ?? []
      if ["AXTextArea", "AXTextField"].contains(next["role"] as? String ?? "")
        || classes.contains(where: {
          $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
            || $0.hasPrefix("p-workspace__input")
        })
      {
        excluded = true
        break
      }
      if mediaIndex == nil && !downloadMediaClasses.isDisjoint(with: classes) {
        mediaIndex = parent
      }
      if headerIndex == nil && has(next, "c-message_kit__file") { headerIndex = parent }
      if has(next, "c-message_kit__actions") { containerIndex = parent }
      if next["role"] as? String == "AXList" { break }
      current = next
    }
    guard !excluded, let mediaIndex = mediaIndex ?? headerIndex, let containerIndex,
      let media = indexed[mediaIndex], let controlIndex = row["index"] as? Int
    else { continue }
    result.append(
      DownloadTarget(
        mediaIndex: mediaIndex, containerIndex: containerIndex, controlIndex: controlIndex,
        url: url, routeKind: downloadRouteKind(url, contextId: contextId), label: label,
        playbackRequired: has(media, "p-video_message_file")
          || has(media, "p-search_file--audio-player") || detailsAudioRoot(media)))
  }
  // Preserve distinct controls for the wrapper's source-bound representation
  // selection. A media root can expose both a rendition and a file-content link.
  return result
}
struct DownloadCandidate {
  let token: String
  let target: DownloadTarget
  let media: AXUIElement
  let container: AXUIElement
  let control: AXUIElement
  let signature: Data
  let videoPins: TranscriptVideoPins
  let playback: [[String: Any]]
  var receipt: [String: Any] {
    [
      "token": token, "mediaIndex": target.mediaIndex, "containerIndex": target.containerIndex,
      "controlIndex": target.controlIndex, "url": target.url, "routeKind": target.routeKind,
    ]
  }
}
func downloadPlaybackIdle(_ playback: [[String: Any]], required: Bool) -> Bool {
  (!required || !playback.isEmpty) && playback.allSatisfy { $0["value"] as? String == "0" }
}
func downloadCandidates(
  _ observation: [String: Any], _ elements: [Int: AXUIElement], contextId: String?
) throws
  -> [DownloadCandidate]
{
  guard let content = observation["content"] as? [String: Any],
    content["truncated"] as? Bool == false,
    let rows = content["nodes"] as? [[String: Any]]
  else { throw Failure(description: "Download source capture is incomplete") }
  var result: [DownloadCandidate] = []
  for target in downloadTargets(rows, contextId: contextId) {
    guard let media = elements[target.mediaIndex], let container = elements[target.containerIndex],
      let control = elements[target.controlIndex]
    else { continue }
    let playback = try transcriptPlayback(media)
    guard downloadPlaybackIdle(playback, required: target.playbackRequired) else { continue }
    let pins = TranscriptVideoPins()
    try pins.observe(
      transcriptVideoLayouts(transcriptRawSourceRows(rows, target.containerIndex)), elements)
    result.append(
      DownloadCandidate(
        token: UUID().uuidString, target: target, media: media, container: container,
        control: control,
        signature: try transcriptSourceSignature(
          rows, target.containerIndex, selectedMediaIndex: target.mediaIndex),
        videoPins: pins, playback: playback))
  }
  try require(result.count <= 1000, "Download control inventory exceeds capture bounds")
  return result
}
func downloadSelectionToken(_ data: Data, _ allowed: Set<String>) throws -> String {
  try require(data.count <= 4096, "Download selection exceeds bounds; no Download action requested")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value.count == 1, let token = value["token"] as? String, allowed.contains(token)
  else {
    throw Failure(
      description: "Download selection was cancelled or unverified; no Download action requested")
  }
  return token
}

// Reopening authorizes only a bounded search for a remembered message. It is
// separate from every Download/viewer capability, which must be issued again
// from fresh observations after the exact source message has been found.
struct MediaSourceRequest {
  let workspace: String
  let messageRef: String
  var message: MessageLink { try! MessageLink(messageRef) }
  var receipt: [String: Any] { ["workspace": workspace, "messageRef": messageRef] }
  var dateFilter: String {
    let seconds = Double(message.messageTS.split(separator: ".")[0])!
    let day = floor(seconds / 86400) * 86400
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd"
    // Slack search uses calendar dates in the user's timezone. This window
    // includes the target instant in every supported timezone without guessing
    // their settings; exact message identity still decides acceptance.
    let after = formatter.string(from: Date(timeIntervalSince1970: day - 86400))
    let before = formatter.string(from: Date(timeIntervalSince1970: day + 172800))
    return "after:\(after) before:\(before)"
  }
}
func mediaSourceRequest(_ data: Data, requested: String, contextId: String?) throws
  -> MediaSourceRequest?
{
  try require(data.count <= 4096, "Source reopening request exceeds bounds; no input performed")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value["reopenSource"] != nil
  else { return nil }
  guard value.count == 1, let source = value["reopenSource"] as? [String: Any],
    source.count == 2, let workspace = source["workspace"] as? String,
    workspace.range(of: #"\A[TE][A-Z0-9]{1,63}\z"#, options: .regularExpression) != nil,
    workspace == contextId, let reference = source["messageRef"] as? String,
    reference.range(
      of: #"\A[CDG][A-Z0-9]{1,63}:[0-9]{10}\.[0-9]{6}\z"#, options: .regularExpression)
      != nil,
    validMediaReference(requested),
    requested.hasPrefix("F") || requested.split(separator: "/").first.map(String.init) == reference
  else {
    throw Failure(
      description: "Source reopening reference or workspace is unverified; no input performed")
  }
  return MediaSourceRequest(workspace: workspace, messageRef: reference)
}
func mediaSourceMessageExposed(_ rows: [[String: Any]], _ requested: MessageLink) -> Bool {
  rows.contains { row in
    guard row["role"] as? String == "AXLink",
      (row["classes"] as? [String] ?? []).contains("c-timestamp"),
      let url = row["url"] as? String, let observed = try? MessageLink(url)
    else { return false }
    return observed.sameMessage(requested)
  }
}
func messageOwnsSourceMedia(_ rows: [[String: Any]], _ mediaIndex: Int) -> Bool {
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  var current = indexed[mediaIndex]
  var messageOwner = false
  var visited = Set<Int>()
  for _ in 0..<40 {
    guard let row = current, let index = row["index"] as? Int, visited.insert(index).inserted
    else { return false }
    let names = row["classes"] as? [String] ?? []
    if ["AXTextArea", "AXTextField"].contains(row["role"] as? String ?? "")
      || names.contains(where: {
        $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
          || $0.hasPrefix("p-workspace__input")
      })
    {
      return false
    }
    if names.contains("c-message_kit__actions") { messageOwner = true }
    if row["role"] as? String == "AXList" { return messageOwner }
    guard let parent = row["parent"] as? Int else { return messageOwner }
    current = indexed[parent]
  }
  return false
}
func requireMediaSourceAbsent(
  _ observations: [[String: Any]], _ source: MediaSourceRequest, requested: String
) throws {
  try require(observations.count == 2, "Source reopening requires two complete observations")
  for observation in observations {
    guard let content = observation["content"] as? [String: Any],
      content["truncated"] as? Bool == false, let rows = content["nodes"] as? [[String: Any]]
    else { throw Failure(description: "Source reopening requires complete source captures") }
    try require(
      !mediaSourceMessageExposed(rows, source.message),
      "Source message is already exposed; changed or unsupported media cannot trigger reopening")
    if requested.hasPrefix("F") {
      for row in rows {
        guard let index = row["index"] as? Int,
          !Set(row["classes"] as? [String] ?? []).isDisjoint(
            with: downloadMediaClasses.union(["c-message_kit__file"])),
          messageOwnsSourceMedia(rows, index)
        else { continue }
        // Downloads toasts and other file surfaces can reuse attachment classes.
        // Only message-owned media can make the source already exposed.
        guard let identities = detailsFileIDs(rows, index) else {
          throw Failure(
            description:
              "An exposed message attachment has an unverified file identity; source absence cannot be established, so reopening was withheld"
          )
        }
        try require(
          !identities.contains(requested),
          "Attachment is already exposed in a message; rejected controls cannot trigger source reopening"
        )
      }
    }
  }
}
// A source request grants navigation only. Every Download capability is rebuilt
// after the exact message is visible in two complete fresh observations.
func sourceConversationListMatchesTitle(_ title: String, _ identifier: String, _ listLabel: String)
  -> Bool
{
  if mainListMatchesTitle(title, identifier, listLabel) { return true }
  // Slack labels private/shared channels separately in the primary list,
  // while retaining the ordinary Channel title and exact C/G conversation URL.
  guard let delimiter = title.range(of: " (Channel) - ") else { return false }
  let literal = String(title[..<delimiter.lowerBound])
  let decorated = literal.hasPrefix("* ") || literal.hasPrefix("! ")
  let names = [literal] + (decorated ? [String(literal.dropFirst(2))] : [])
  return names.contains { name in
    !name.isEmpty && destinationMatches(title, identifier, name, .channel)
      && ["private channel", "shared channel"].contains { kind in
        listLabel == "\(name) (\(kind))" || listLabel.hasPrefix("\(name) (\(kind),")
      }
  }
}
func mediaSourceConversationReady(_ root: AXUIElement, _ identifier: String) throws -> Bool {
  guard try queryFields(root).isEmpty,
    (attr(root, kAXURLAttribute) as? URL)?.lastPathComponent == identifier
  else { return false }
  let lists = try tree(root).filter {
    role($0.element) == "AXList"
      && sourceConversationListMatchesTitle(label(root), identifier, label($0.element))
      && ancestor($0.element, matching: { classes($0).contains("p-workspace__primary_view_body") })
        != nil
      && ancestor(
        $0.element, matching: { classes($0).contains(where: { $0.hasPrefix("p-thread") }) }) == nil
  }
  try require(lists.count <= 1, "Source conversation message list is ambiguous")
  return lists.count == 1
}
func sourceChannelPresentation(_ element: AXUIElement) -> Bool {
  let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
  if children.isEmpty { return true }
  guard children.count == 3,
    role(children[0]) == "AXStaticText", !label(children[0]).isEmpty,
    role(children[1]) == "AXGroup", label(children[1]).isEmpty,
    role(children[2]) == "AXStaticText", label(children[2]) == "Public channel"
  else { return false }
  let separator = attr(children[1], kAXChildrenAttribute) as? [AXUIElement] ?? []
  guard separator.count == 1, role(separator[0]) == "AXStaticText", label(separator[0]) == "·"
  else { return false }
  return (children + separator).allSatisfy {
    classes($0).isEmpty && attr($0, kAXURLAttribute) == nil
  }
    && [children[0], children[2], separator[0]].allSatisfy {
      (attr($0, kAXChildrenAttribute) as? [AXUIElement] ?? []).isEmpty
    }
}
func sourceIDQueryMatches(
  _ value: String, _ identifier: String, optionCount: Int, exactQueryCount: Int
) -> Bool {
  optionCount == 2 && exactQueryCount == 1
    && [identifier, "\(identifier) — Search"].contains(value)
}
func sourceIDCandidate(_ root: AXUIElement, _ identifier: String) throws -> AXUIElement? {
  let fields = try queryFields(root)
  let options = try pickerSuggestions(root)
  let query = options.filter {
    exactGroupLookupQueryOption(label($0.element), classes($0.element), identifier)
  }
  guard fields.count == 1,
    sourceIDQueryMatches(
      string(fields[0].element, kAXValueAttribute), identifier,
      optionCount: options.count, exactQueryCount: query.count)
  else { return nil }
  let navigation = options.filter { groupLookupNavigation(classes($0.element)) }
  guard navigation.count == 1, let candidate = navigation.first,
    isSuggestion(candidate),
    classes(candidate.element).contains("c-search_autocomplete__suggestion_item"),
    attr(candidate.element, kAXEnabledAttribute) as? Bool == true,
    !label(candidate.element).isEmpty, label(candidate.element).count <= 500,
    !identifier.hasPrefix("D")
  else { return nil }
  return try groupLookupMatch(candidate, 1) || sourceChannelPresentation(candidate.element)
    ? candidate.element : nil
}
struct SourceSidebarSelection {
  let page: ListingPage
  let row: AXUIElement
  let control: AXUIElement
  let dm: SidebarDM?
}
func sourceSidebarSelection(_ root: AXUIElement, _ identifier: String) throws
  -> SourceSidebarSelection?
{
  let page = try sidebarPage(root)
  let rows = page.rows.filter { string($0.element, "AXDOMIdentifier") == identifier }
  if rows.isEmpty { return nil }
  try require(rows.count == 1, "Source conversation sidebar ID is ambiguous; input withheld")
  let dm = page.dmIdentities[identifier]
  try require(
    (dm != nil) != page.channelIds.contains(identifier),
    "Source sidebar ID does not have one verified conversation kind; input withheld")
  let controls = (attr(rows[0].element, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
    role($0) == "AXGroup" && classes($0).contains("p-channel_sidebar__channel")
  }
  try require(controls.count == 1, "Source sidebar row has no unique direct conversation control")
  return SourceSidebarSelection(page: page, row: rows[0].element, control: controls[0], dm: dm)
}
func navigateMediaSourceConversation(
  _ source: MediaSourceRequest, _ workspace: Workspace,
  _ running: NSRunningApplication, _ deadline: Date
) throws {
  let identifier = source.message.conversationId
  var root = try workspace.root()
  if try mediaSourceConversationReady(root, identifier) { return }
  try ensureSidebar(workspace, running, inputDeadline: deadline)
  root = try workspace.root()
  if try mediaSourceConversationReady(root, identifier) { return }
  let window = try windowId(workspace.window, workspace.pid)
  var expectedDM = false
  if let selected = try sourceSidebarSelection(root, identifier) {
    expectedDM = selected.dm != nil
    settle()
    root = try workspace.root()
    guard let fresh = try sourceSidebarSelection(root, identifier) else {
      throw Failure(description: "Source conversation sidebar target disappeared; input withheld")
    }
    try require(
      fresh.page.scopeKey == selected.page.scopeKey && fresh.dm == selected.dm
        && CFEqual(fresh.row, selected.row) && CFEqual(fresh.control, selected.control),
      "Source sidebar target changed; input withheld")
    try sampleDesktop("before-source-sidebar-navigation")
    _ = try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      input: {
        try activate(
          fresh.control, focusTarget: fresh.row, workspace, window: window,
          what: "Source sidebar row", inputDeadline: deadline
        ) {
          guard let url = attr(try workspace.root(), kAXURLAttribute) as? URL else {
            return false
          }
          return url.lastPathComponent == identifier
        }
      })
  } else {
    try require(
      !identifier.hasPrefix("D"),
      "Source DM is not exposed in Home and exact-ID lookup cannot verify it. Use dms/read-dm to expose the conversation, then retry the reference; no guessed participant used"
    )
    try requireNoModal(workspace.window)
    let buttons = try tree(root).filter(searchButton)
    try require(buttons.count == 1, "Source lookup Search button is ambiguous")
    try sampleDesktop("before-source-id-search")
    _ = try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      input: {
        try activate(
          buttons[0].element, workspace, window: window, what: "Search", inputDeadline: deadline
        ) { try !queryFields(workspace.root()).isEmpty }
      })
    let openDeadline = min(deadline, Date().addingTimeInterval(5))
    repeat {
      settle()
      root = try workspace.root()
      if try queryFields(root).count == 1 { break }
    } while Date() < openDeadline
    let fields = try queryFields(root)
    try require(fields.count == 1, "Source lookup did not expose one Query field")
    try sampleDesktop("immediately-before-source-id-query")
    try requireNoModal(workspace.window)
    try require(try windowId(workspace.window, workspace.pid) == window, "Source window changed")
    try requireQueryFocus(root)
    try requireGroupLookupBudget(deadline)
    try require(
      try interactionAXValue(
        fields[0].element, kAXValueAttribute as CFString,
        identifier as CFString) == .success, "Source ID query was refused")
    let suggestionDeadline = min(deadline, Date().addingTimeInterval(4))
    var retained: AXUIElement?
    repeat {
      settle()
      root = try workspace.root()
      retained = try sourceIDCandidate(root, identifier)
      if retained != nil { break }
    } while Date() < suggestionDeadline
    guard let retained else {
      throw Failure(
        description:
          "Exact source ID did not expose one supported channel/group navigation option; Return withheld. Expose the conversation with read-channel/read-dm before retrying"
      )
    }
    let name = label(retained)
    var selected = false
    for _ in 0..<12 {
      root = try workspace.root()
      guard let fresh = try sourceIDCandidate(root, identifier), CFEqual(fresh, retained),
        label(fresh) == name
      else {
        throw Failure(description: "Source ID navigation changed; Return withheld")
      }
      let active = try pickerSuggestions(root).filter {
        attr($0.element, kAXSelectedAttribute) as? Bool == true
      }
      if active.count == 1 && CFEqual(active[0].element, retained) {
        selected = true
        break
      }
      try backgroundKey(
        125, "\u{F701}", root, workspace.window, window, workspace.pid, inputDeadline: deadline)
    }
    try require(selected, "Exact source navigation could not be selected; Return withheld")
    root = try workspace.root()
    guard let fresh = try sourceIDCandidate(root, identifier), CFEqual(fresh, retained),
      label(fresh) == name
    else {
      throw Failure(description: "Source ID navigation changed immediately before Return")
    }
    expectedDM = try tree(retained).contains {
      role($0.element) == "AXGroup"
        && classes($0.element).contains("c-small_mpim_entity__mpim_counter--updated")
    }
    try backgroundKey(
      36, "\r", root, workspace.window, window, workspace.pid,
      expectedSuggestion: retained, inputDeadline: deadline)
  }
  let verifyDeadline = min(deadline, Date().addingTimeInterval(8))
  repeat {
    settle()
    try sampleDesktop("verify-source-conversation")
    root = try workspace.root()
    try requireNoModal(workspace.window)
    if try mediaSourceConversationReady(root, identifier),
      label(root).contains(expectedDM ? " (DM) - " : " (Channel) - ")
    {
      return
    }
  } while Date() < verifyDeadline
  throw Failure(
    description:
      "Source navigation attempted once, but its exact conversation URL and message list did not verify; inspect before retrying"
  )
}
func sourceChannelScope(_ content: [String: Any], _ identifier: String) -> String? {
  guard content["truncated"] as? Bool == false, let rows = content["nodes"] as? [[String: Any]]
  else { return nil }
  let fields = rows.filter {
    $0["label"] as? String == "Query"
      && ["AXComboBox", "AXTextField"].contains($0["role"] as? String ?? "")
  }
  let tokens = rows.filter {
    ($0["classes"] as? [String] ?? []).contains("c-member_slug--search-filter")
  }
  let active = rows.filter { ($0["classes"] as? [String] ?? []).contains("c-filter-pill--active") }
  guard fields.count == 1, tokens.count == 1, active.count == 1,
    active[0]["role"] as? String == "AXCheckBox",
    active[0]["id"] as? String == "quick-filter-in-\(identifier)",
    active[0]["label"] as? String == "In this channel", active[0]["stateValue"] as? String == "1",
    let tokenIndex = tokens[0]["index"] as? Int, let fieldIndex = fields[0]["index"] as? Int,
    let tokenLabel = tokens[0]["label"] as? String,
    let value = fields[0]["AXValue"] as? String,
    value.trimmingCharacters(in: .whitespaces) == tokenLabel
  else { return nil }
  var cursor = tokens[0]["parent"] as? Int
  var seen = Set<Int>()
  while let index = cursor, index != fieldIndex, seen.insert(index).inserted {
    cursor = rows.first { $0["index"] as? Int == index }?["parent"] as? Int
  }
  guard cursor == fieldIndex else { return nil }
  let children = rows.filter { $0["parent"] as? Int == tokenIndex }
  guard children.count == 2, children.allSatisfy({ $0["role"] as? String == "AXStaticText" }),
    children[0]["label"] as? String == "in:", let name = children[1]["label"] as? String,
    name.range(of: #"\A[a-z0-9_-]{1,80}\z"#, options: .regularExpression) != nil,
    tokenLabel == "in:\(name) Channel"
  else { return nil }
  return name
}
func searchMediaSource(
  _ source: MediaSourceRequest, _ workspace: Workspace,
  _ running: NSRunningApplication, _ deadline: Date
) throws -> String {
  let root = try workspace.root()
  let window = try windowId(workspace.window, workspace.pid)
  try require(
    try mediaSourceConversationReady(root, source.message.conversationId),
    "Source conversation changed before scoped Search")
  // DM scope can be UID-bound and cannot prove an exact conversation ID. Leave
  // that shape unsupported rather than searching a guessed participant/name.
  try require(
    label(root).contains(" (Channel) - "),
    "Older DM/group source is not exposed; exact conversation-scoped Search is unsupported for this view. Read older messages/thread first, then retry its fresh media reference"
  )
  let headers = try tree(root).filter { node in
    guard role(node.element) == "AXButton", label(node.element) == "Search in channel",
      classes(node.element).contains("p-view_header_search_action_button"),
      let parent = attr(node.element, kAXParentAttribute),
      CFGetTypeID(parent) == AXUIElementGetTypeID()
    else { return false }
    let toolbar = parent as! AXUIElement
    guard role(toolbar) == "AXToolbar", label(toolbar) == "Primary view actions",
      classes(toolbar).contains("p-view_header"),
      let grandparent = attr(toolbar, kAXParentAttribute),
      CFGetTypeID(grandparent) == AXUIElementGetTypeID()
    else { return false }
    let owner = grandparent as! AXUIElement
    return classes(owner).contains("p-view_contents")
      && classes(owner).contains("p-view_contents--primary")
  }
  try require(headers.count == 1, "Source conversation Search owner is unavailable or ambiguous")
  try requireNoModal(workspace.window)
  try sampleDesktop("before-source-scoped-search")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireNoModal(workspace.window) },
    input: { try press(headers[0].element, inputDeadline: deadline) })
  let openDeadline = min(deadline, Date().addingTimeInterval(5))
  var name: String?
  repeat {
    settle()
    let fresh = try workspace.root()
    if (attr(fresh, kAXURLAttribute) as? URL)?.lastPathComponent == source.message.conversationId {
      name = sourceChannelScope(try contentSnapshot(fresh), source.message.conversationId)
    }
    if name != nil { break }
  } while Date() < openDeadline
  guard let name else {
    throw Failure(
      description:
        "Slack did not expose an exact conversation-ID-bound Search filter; query submission withheld"
    )
  }
  settle()
  try require(
    sourceChannelScope(try contentSnapshot(workspace.root()), source.message.conversationId)
      == name,
    "Source Search scope changed before query preparation")
  let query = "in:\(name) \(source.dateFilter)"
  let normalizedInput = "in:#\(name) \(source.dateFilter)"
  let fresh = try workspace.root()
  let fields = try queryFields(fresh)
  try require(fields.count == 1, "Scoped source Query field changed")
  try sampleDesktop("immediately-before-source-scoped-query")
  try requireNoModal(workspace.window)
  try require(try windowId(workspace.window, workspace.pid) == window, "Source window changed")
  try requireQueryFocus(fresh)
  try requireGroupLookupBudget(deadline)
  try require(
    try interactionAXValue(
      fields[0].element, kAXValueAttribute as CFString,
      query as CFString) == .success, "Scoped source query was refused")
  let suggestionDeadline = min(deadline, Date().addingTimeInterval(4))
  var corroborated = false
  repeat {
    settle()
    let fresh = try workspace.root()
    let fields = try queryFields(fresh)
    let options = try pickerSuggestions(fresh)
    corroborated =
      fields.count == 1
      && [query, "\(query) — Search"].contains(string(fields[0].element, kAXValueAttribute))
      && options.filter {
        exactGroupLookupQueryOption(label($0.element), classes($0.element), normalizedInput)
      }.count == 1
    if corroborated { break }
  } while Date() < suggestionDeadline
  try require(
    corroborated, "Slack did not corroborate the exact scoped source query; Return withheld")
  _ = try search(normalizedInput, workspace, running, inputDeadline: deadline, resultQuery: query)
  return query
}

func downloadFinishRequest(_ data: Data) throws {
  try require(data.count <= 4096, "Download completion message exceeds bounds")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value.count == 1,
    let finish = value["finish"] as? NSNumber, CFGetTypeID(finish) == CFBooleanGetTypeID(),
    finish.boolValue
  else {
    throw Failure(
      description: "Download completion was cancelled or unverified; do not replay input")
  }
}
func downloadWorkspaceCheckpointRequest(_ data: Data) throws {
  try require(data.count <= 4096, "Download workspace checkpoint exceeds bounds")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value.count == 1,
    let verify = value["verifyWorkspace"] as? NSNumber,
    CFGetTypeID(verify) == CFBooleanGetTypeID(), verify.boolValue
  else {
    throw Failure(
      description:
        "Scoped download requires one workspace checkpoint before completion; do not replay input")
  }
}
func downloadInputLine(_ deadline: Date, duringWait: () throws -> Void) throws -> Data {
  var data = Data()
  var nextSample = Date.distantPast
  while Date() < deadline {
    axPause(until: Date().addingTimeInterval(0.01))
    try require(
      !interrupted, "Download operation interrupted; inspect state before another command")
    if Date() >= nextSample {
      try duringWait()
      nextSample = Date().addingTimeInterval(0.4)
    }
    var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    let ready = poll(&descriptor, 1, 100)
    try require(ready >= 0 || errno == EINTR, "Download protocol input failed")
    if ready <= 0 { continue }
    var byte: UInt8 = 0
    let count = read(STDIN_FILENO, &byte, 1)
    try require(
      count > 0, "Download protocol closed before completion; inspect state before another command")
    if byte == 10 { return data }
    data.append(byte)
    try require(data.count <= 4096, "Download protocol message exceeds bounds")
  }
  throw Failure(description: "Download protocol timed out; do not replay uncertain input")
}
func verifyDownloadPlayback(_ selected: DownloadCandidate) throws -> [[String: Any]] {
  let playback = try transcriptPlayback(selected.media)
  try require(
    downloadPlaybackIdle(playback, required: selected.target.playbackRequired)
      && NSDictionary(dictionary: ["values": selected.playback]).isEqual(to: ["values": playback]),
    "Selected media playback changed or became unknown; download verification stopped")
  return playback
}
func verifyDownloadSource(_ selected: DownloadCandidate, _ workspace: Workspace) throws -> [[String:
  Any]]
{
  let root = try workspace.root()
  try requireNoModal(workspace.window)
  try require(try queryFields(root).isEmpty, "Search picker appeared; Download action withheld")
  let nodes = try tree(root)
  try require(
    nodes.contains { CFEqual($0.element, selected.container) },
    "Download source container disappeared")
  var elements: [Int: AXUIElement] = [:]
  var mediaIndex: Int?
  var controlIndex: Int?
  let content = try contentSnapshot(
    selected.container,
    onNode: { index, element in
      elements[index] = element
      if CFEqual(element, selected.media) { mediaIndex = index }
      if CFEqual(element, selected.control) { controlIndex = index }
    })
  let rows = content["nodes"] as! [[String: Any]]
  try require(
    mediaIndex != nil && controlIndex != nil
      && transcriptControlWithinMedia(rows, mediaIndex!, controlIndex!),
    "Download control left its retained media source")
  let freshTargets = downloadTargets(
    rows, contextId: workspace.context.split(separator: "/").last.map(String.init))
  try require(
    freshTargets.contains {
      $0.mediaIndex == mediaIndex && $0.controlIndex == controlIndex && $0.containerIndex == 0
        && $0.url.utf8.elementsEqual(selected.target.url.utf8)
        && $0.routeKind == selected.target.routeKind
        && $0.label.utf8.elementsEqual(selected.target.label.utf8)
    }, "Download control role, label, URL or ownership changed")
  try require(
    try transcriptSourceSignature(rows, 0, selectedMediaIndex: mediaIndex) == selected.signature,
    "Selected message/media identity or order changed; Download action withheld")
  try selected.videoPins.observe(transcriptVideoLayouts(rows), elements)
  return try verifyDownloadPlayback(selected)
}
// Viewer fallback is an independent source-bound capability. An image URL is
// identity evidence only; the viewer's URL-less button is not a Download URL.
struct ViewerFileIdentity {
  let ownerTeamId: String
  let fileId: String
}
func viewerImageIdentity(_ value: String, contextId: String?) -> ViewerFileIdentity? {
  guard value.utf8.count <= 16384,
    let expression = try? NSRegularExpression(
      pattern:
        #"\Ahttps://files\.slack\.com/files-pri/(T[A-Z0-9]+)-(F[A-Z0-9]+)/([A-Za-z0-9._~!$&'()*+,;=:@%\-]+)(?:\?origin_team=([TE][A-Z0-9]+))?\z"#
    ),
    let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
    let ownerRange = Range(match.range(at: 1), in: value),
    let fileRange = Range(match.range(at: 2), in: value),
    let nameRange = Range(match.range(at: 3), in: value),
    let name = String(value[nameRange]).removingPercentEncoding,
    !name.isEmpty, ![".", ".."].contains(name), !name.contains("/"), !name.contains("\\"),
    !name.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) })
  else { return nil }
  if match.range(at: 4).location != NSNotFound {
    guard let queryRange = Range(match.range(at: 4), in: value),
      String(value[queryRange]) == contextId
    else { return nil }
  }
  return ViewerFileIdentity(
    ownerTeamId: String(value[ownerRange]), fileId: String(value[fileRange]))
}
struct ViewerOpenerTarget {
  let containerIndex: Int
  let mediaIndex: Int
  let controlIndex: Int
  let sourceURL: String
  let identity: ViewerFileIdentity
}
func viewerOpenerTargets(_ rows: [[String: Any]], contextId: String?) -> [ViewerOpenerTarget] {
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func has(_ row: [String: Any], _ name: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(name)
  }
  var result: [ViewerOpenerTarget] = []
  for media in rows
  where has(media, "p-message_gallery_image_file")
    && has(media, "c-file_gallery_image_file")
  {
    guard let mediaIndex = media["index"] as? Int, media["role"] as? String == "AXGroup" else {
      continue
    }
    let scoped = transcriptRawSourceRows(rows, mediaIndex)
    // A hidden/disabled/unsupported Download is not permission to bypass a
    // failed direct guard. Only a genuinely absent Download gets an opener.
    guard
      !scoped.contains(where: {
        downloadLabel($0["label"] as? String ?? "")
          && ["AXLink", "AXButton", "AXMenuItem"].contains($0["role"] as? String ?? "")
      })
    else { continue }
    let nested = scoped.dropFirst().contains { row in
      !(Set(row["classes"] as? [String] ?? []).intersection(downloadMediaClasses)).isEmpty
        || has(row, "c-message_kit__actions")
        || ["AXTextArea", "AXTextField"].contains(row["role"] as? String ?? "")
        || (row["classes"] as? [String] ?? []).contains(where: {
          $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
            || $0.hasPrefix("p-workspace__input")
        })
    }
    guard !nested,
      !scoped.contains(where: {
        ["AXButton", "AXCheckBox"].contains($0["role"] as? String ?? "")
          && ((($0["label"] as? String ?? "").hasPrefix("Play"))
            || (($0["label"] as? String ?? "").hasPrefix("Pause")))
      })
    else { continue }
    let controls = scoped.filter {
      $0["role"] as? String == "AXLink" && has($0, "p-file_image_thumbnail__wrapper")
    }
    guard controls.count == 1, let control = controls.first,
      let controlIndex = control["index"] as? Int,
      let sourceURL = control["url"] as? String,
      let identity = viewerImageIdentity(sourceURL, contextId: contextId),
      transcriptVideoFileIds(rows, mediaIndex) == Set([identity.fileId]),
      transcriptRawSourceRows(rows, controlIndex).filter({
        $0["role"] as? String == "AXImage" && has($0, "p-file_image_thumbnail__image")
      }).count == 1
    else { continue }
    var parent = media
    var container: Int?
    var blocked = false
    for _ in 0..<40 {
      let parentClasses = parent["classes"] as? [String] ?? []
      if parentClasses.contains(where: {
        $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
          || $0.hasPrefix("p-workspace__input") || $0 == "p-media_viewer_modal"
      }) || ["AXTextArea", "AXTextField"].contains(parent["role"] as? String ?? "") {
        blocked = true
        break
      }
      if has(parent, "c-message_kit__actions") {
        container = parent["index"] as? Int
        break
      }
      guard let parentIndex = parent["parent"] as? Int, let next = indexed[parentIndex] else {
        break
      }
      parent = next
    }
    guard !blocked, let container else { continue }
    result.append(
      ViewerOpenerTarget(
        containerIndex: container, mediaIndex: mediaIndex,
        controlIndex: controlIndex, sourceURL: sourceURL, identity: identity))
  }
  return result
}
struct ViewerDownloadTarget: Equatable {
  let viewerIndex: Int
  let branchIndex: Int
  let mediaIndex: Int
  let imageIndex: Int
  let footerIndex: Int
  let controlIndex: Int
  let closeIndex: Int
  let closeParentIndex: Int
}
func viewerDownloadTarget(_ rows: [[String: Any]], sourceURL: String) -> ViewerDownloadTarget? {
  func has(_ row: [String: Any], _ name: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(name)
  }
  func children(_ index: Int) -> [[String: Any]] { rows.filter { $0["parent"] as? Int == index } }
  func one(_ candidates: [[String: Any]], _ role: String, _ name: String) -> [String: Any]? {
    let found = candidates.filter { $0["role"] as? String == role && has($0, name) }
    return found.count == 1 ? found[0] : nil
  }
  guard let viewer = one(rows, "AXGroup", "p-media_viewer_modal"),
    viewer["index"] as? Int == 0,
    [
      "ReactModal__Content", "ReactModal__Content--after-open", "c-sk-modal",
      "c-sk-modal--fullscreen",
    ].allSatisfy({ has(viewer, $0) }),
    let multimedia = one(children(0), "AXGroup", "p-media_viewer_modal__multimedia"),
    has(multimedia, "p-media_viewer_modal__messages"),
    let multimediaIndex = multimedia["index"] as? Int,
    let branch = one(
      children(multimediaIndex), "AXGroup", "p-media_viewer_modal__multimedia_video"),
    let branchIndex = branch["index"] as? Int,
    let media = one(rows, "AXGroup", "p-file_viewer"), media["parent"] as? Int == branchIndex,
    let mediaIndex = media["index"] as? Int,
    let content = one(children(mediaIndex), "AXGroup", "p-file_viewer__content"),
    let contentIndex = content["index"] as? Int,
    children(contentIndex).count == 1,
    let imageViewer = one(children(contentIndex), "AXGroup", "p-image_viewer"),
    let imageViewerIndex = imageViewer["index"] as? Int,
    children(imageViewerIndex).count == 1,
    let image = one(children(imageViewerIndex), "AXImage", "p-image_viewer__image"),
    let imageIndex = image["index"] as? Int,
    (image["url"] as? String)?.utf8.elementsEqual(sourceURL.utf8) == true,
    let footer = one(children(branchIndex), "AXToolbar", "p-media_viewer_modal__footer"),
    let footerIndex = footer["index"] as? Int
  else { return nil }
  let branchRows = transcriptRawSourceRows(rows, branchIndex)
  let downloads = branchRows.filter {
    downloadLabel($0["label"] as? String ?? "")
      && ["AXLink", "AXButton", "AXMenuItem"].contains($0["role"] as? String ?? "")
  }
  // Slack exposes the viewer Close in either of these observed direct-owner
  // positions. Inventory the whole viewer first so a second or foreign Close
  // cannot disappear merely because it is outside the supported placement.
  let closes = rows.filter { has($0, "p-media_viewer_modal__tabs_close") }
  func supportedDownload(_ download: [String: Any]) -> Bool {
    if has(download, "p-file_viewer__header__button")
      && has(download, "p-media_viewer_modal__icon_button")
    {
      return true
    }
    // The observed newer image viewer omits the legacy header-button class.
    // Bind that variant to its exact footer, leaf state and class inventories.
    let buttonClasses: Set<String> = [
      "c-button-unstyled", "c-icon_button", "c-icon_button--size_medium",
      "p-media_viewer_modal__icon_button", "c-icon_button--dark",
    ]
    let focusedButtonClasses = buttonClasses.union(["c-button--focus-visible"])
    let footerClasses: Set<String> = [
      "p-media_viewer_modal__footer", "p-media_viewer_modal__footer--slide_over_content",
    ]
    guard let observedButtonClasses = download["classes"] as? [String],
      observedButtonClasses.count == Set(observedButtonClasses).count,
      [buttonClasses, focusedButtonClasses].contains(Set(observedButtonClasses)),
      let observedFooterClasses = footer["classes"] as? [String],
      observedFooterClasses.count == footerClasses.count,
      Set(observedFooterClasses) == footerClasses,
      footer["id"] as? String == "", footer["label"] as? String == "Media controls",
      footer["url"] == nil, download["id"] as? String == "",
      download["selected"] as? Bool == false, download["stateValue"] as? String == "",
      download["AXValue"] as? String == "", let index = download["index"] as? Int,
      children(index).isEmpty
    else { return false }
    return true
  }
  guard downloads.count == 1, let download = downloads.first,
    download["role"] as? String == "AXButton", download["parent"] as? Int == footerIndex,
    download["label"] as? String == "Download", download["url"] == nil,
    supportedDownload(download),
    let controlIndex = download["index"] as? Int,
    closes.count == 1, closes[0]["role"] as? String == "AXButton",
    closes[0]["label"] as? String == "Close", let closeIndex = closes[0]["index"] as? Int,
    let closeParentIndex = closes[0]["parent"] as? Int,
    closeParentIndex == multimediaIndex || closeParentIndex == branchIndex,
    !branchRows.contains(where: {
      ["AXButton", "AXCheckBox"].contains($0["role"] as? String ?? "")
        && ((($0["label"] as? String ?? "").hasPrefix("Play"))
          || (($0["label"] as? String ?? "").hasPrefix("Pause")))
    })
  else { return nil }
  return ViewerDownloadTarget(
    viewerIndex: 0, branchIndex: branchIndex, mediaIndex: mediaIndex,
    imageIndex: imageIndex, footerIndex: footerIndex, controlIndex: controlIndex,
    closeIndex: closeIndex, closeParentIndex: closeParentIndex)
}
struct ViewerOpenerCandidate {
  let token: String
  let target: ViewerOpenerTarget
  let container: AXUIElement
  let media: AXUIElement
  let control: AXUIElement
  let signature: Data
  let toolbarBaseline: ViewerToolbarVisibilityBaseline?
  var receipt: [String: Any] {
    [
      "token": token, "scope": "viewer-opener", "containerIndex": target.containerIndex,
      "mediaIndex": target.mediaIndex, "controlIndex": target.controlIndex,
      "sourceURL": target.sourceURL, "fileId": target.identity.fileId,
      "ownerTeamId": target.identity.ownerTeamId,
    ]
  }
}
func viewerOpenerCandidates(
  _ observation: [String: Any], _ elements: [Int: AXUIElement],
  contextId: String?
) throws -> [ViewerOpenerCandidate] {
  guard let content = observation["content"] as? [String: Any],
    content["truncated"] as? Bool == false,
    let rows = content["nodes"] as? [[String: Any]]
  else { throw Failure(description: "Viewer source capture is incomplete") }
  let result = try viewerOpenerTargets(rows, contextId: contextId).map {
    target -> ViewerOpenerCandidate in
    guard let container = elements[target.containerIndex], let media = elements[target.mediaIndex],
      let control = elements[target.controlIndex]
    else { throw Failure(description: "Viewer opener identity is unavailable") }
    let sourceRows = transcriptRawSourceRows(rows, target.containerIndex)
    let sourceIndexes = Dictionary(
      uniqueKeysWithValues: sourceRows.enumerated().map { ($0.element["index"] as! Int, $0.offset) }
    )
    var toolbarBaseline: ViewerToolbarVisibilityBaseline?
    if let toolbarIndexes = viewerFileToolbar(
      rows, rootIndex: target.containerIndex, mediaIndex: target.mediaIndex, offscreen: false),
      let toolbarRow = sourceRows.first(where: {
        $0["parent"] as? Int == target.containerIndex
          && toolbarIndexes.contains($0["index"] as! Int)
      }),
      let toolbar = elements[toolbarRow["index"] as! Int],
      let baselineRows = try JSONSerialization.jsonObject(
        with: viewerRawSourceSignature(rows, target.containerIndex)) as? [[String: Any]],
      let baselineMediaIndex = sourceIndexes[target.mediaIndex]
    {
      toolbarBaseline = ViewerToolbarVisibilityBaseline(
        element: toolbar, rows: baselineRows, mediaIndex: baselineMediaIndex)
    }
    return ViewerOpenerCandidate(
      token: UUID().uuidString, target: target, container: container,
      media: media, control: control,
      signature: try transcriptSourceSignature(
        rows, target.containerIndex, selectedMediaIndex: target.mediaIndex),
      toolbarBaseline: toolbarBaseline)
  }
  try require(result.count <= 1000, "Viewer opener inventory exceeds bounds")
  return result
}
func fileViewerPanels(_ root: AXUIElement) throws -> [AXUIElement] {
  try tree(root).filter { classes($0.element).contains("p-media_viewer_modal") }.map { $0.element }
}
// Slack implements its informational download toast with ReactModal too. Only
// this observed notification shape is inert for viewer isolation; no control
// inside the toast is ever selected or pressed by the viewer operation.
func viewerTransientDownloadToast(_ rows: [[String: Any]], subrole: String) -> Bool {
  guard [12, 13].contains(rows.count), subrole == "AXApplicationDialog",
    rows[0]["label"] as? String == "Recent downloads",
    rows[0]["AXTitle"] as? String == "Recent downloads"
  else { return false }
  var expectedClasses: [[String]] = [
    [
      "ReactModal__Content", "ReactModal__Content--after-open", "c-toast", "c-toast--fade",
      "p-download_toast", "c-toast--download",
    ], [],
    [
      "c-pillow_file_container", "c-pillow_file_container--download", "p-download_toast_item",
      "p-download_toast_item--last-item", "c-pillow_file_container--full_width",
      "c-pillow_file_container--active_download",
    ],
    [
      "c-link", "c-button-unstyled", "p-file_link_button--link", "c-pillow_file",
      "c-pillow_file--full_width", "c-pillow_file--active_download", "c-pillow_file--clickable",
    ],
    [
      "p-file_thumbnail__container", "p-file_thumbnail__container--other",
      "c-file_entity_thumbnail_icon", "c-base_entity__avatar",
    ], [], ["c-pillow_file__size", "c-pillow_file__meta__entry"], ["c-pillow_file__swap"], [],
    ["p-download_controls__actions"], ["c-button-unstyled", "p-download_controls__button"],
    ["c-button-unstyled", "p-download_controls__button"],
  ]
  var expectedRoles = [
    "AXGroup", "AXGroup", "AXGroup", "AXLink", "AXGroup", "AXStaticText", "AXGroup", "AXGroup",
    "AXStaticText", "AXGroup", "AXButton", "AXButton",
  ]
  var expectedParents = [0, 0, 1, 2, 3, 3, 3, 6, 7, 1, 9, 9]
  if rows.count == 13 {
    if (rows[2]["classes"] as? [String] ?? []).contains("p-download_toast_item--completed") {
      // Completion replaces the active controls with one View all control and
      // a static status inside a known slide group. Its full shape stays exact.
      expectedClasses[2] += [
        "p-download_toast_item--completed", "p-download_toast_item--other-completed",
      ]
      expectedClasses =
        Array(expectedClasses.prefix(9)) + [
          ["c-pillow_file__slide", "c-pillow_file__size__action"], [],
          ["p-download_controls__viewall"], ["c-button-unstyled", "p-download_controls__button"],
        ]
      expectedRoles =
        Array(expectedRoles.prefix(9)) + [
          "AXGroup", "AXStaticText", "AXGroup", "AXButton",
        ]
      expectedParents = [0, 0, 1, 2, 3, 3, 3, 6, 7, 7, 9, 1, 11]
    } else {
      // The other observed layout splits the size into two static text leaves
      // under the same swap container. No extra node or position is allowed.
      expectedClasses.insert([], at: 9)
      expectedRoles.insert("AXStaticText", at: 9)
      expectedParents = [0, 0, 1, 2, 3, 3, 3, 6, 7, 7, 1, 10, 10]
    }
  }
  return rows.enumerated().allSatisfy { index, row in
    guard row["index"] as? Int == index,
      index == 0 ? row["parent"] is NSNull : row["parent"] as? Int == expectedParents[index],
      row["role"] as? String == expectedRoles[index],
      row["id"] as? String == (index == 1 ? "toast-children" : ""),
      let names = row["classes"] as? [String], names.count == expectedClasses[index].count,
      Set(names) == Set(expectedClasses[index])
    else { return false }
    return true
  }
}
func viewerDownloadToast(_ rows: [[String: Any]], subrole: String) -> Bool {
  if viewerTransientDownloadToast(rows, subrole: subrole) { return true }
  let rootClasses: Set<String> = [
    "ReactModal__Content", "ReactModal__Content--after-open", "c-toast", "c-toast--fade",
    "p-download_toast", "c-toast--download", "c-toast--persistent",
  ]
  guard let root = rows.first, root["index"] as? Int == 0,
    root["role"] as? String == "AXGroup", subrole == "AXApplicationDialog",
    root["label"] as? String == "Recent downloads",
    Set(root["classes"] as? [String] ?? []) == rootClasses
  else { return false }
  let children = rows.filter { $0["parent"] as? Int == 0 }
  guard children.count == 2,
    children.filter({
      $0["role"] as? String == "AXGroup" && $0["id"] as? String == "toast-children"
        && ($0["classes"] as? [String] ?? []).isEmpty
    }).count == 1,
    children.filter({
      $0["role"] as? String == "AXButton" && $0["label"] as? String == "Close"
        && ($0["classes"] as? [String] ?? []).contains("c-toast__close-button")
    }).count == 1
  else { return false }
  return !rows.dropFirst().contains { row in
    ["AXDialog", "AXSheet", "AXMenu", "AXTextField", "AXTextArea"].contains(
      row["role"] as? String ?? "")
      || (row["classes"] as? [String] ?? []).contains(where: {
        $0 == "ReactModal__Content" || $0.hasPrefix("p-media_viewer")
          || $0.hasPrefix("c-sk-modal") || $0 == "p-file_viewer"
      })
  }
}
struct ViewerToastStructuralNode<Element> {
  let element: Element
  let parent: Element?
  let role: String
  let classes: [String]
}
func viewerToastCaptureAccepted<Element>(
  _ rows: [[String: Any]], subrole: String, captured: [Int: Element],
  structural: [ViewerToastStructuralNode<Element>], same: (Element, Element) -> Bool
) -> Bool {
  guard viewerDownloadToast(rows, subrole: subrole) else { return false }
  guard viewerTransientDownloadToast(rows, subrole: subrole) else { return true }
  guard captured.count == rows.count, structural.count == rows.count else { return false }
  for (index, row) in rows.enumerated() {
    guard let element = captured[index],
      !(0..<index).contains(where: { captured[$0].map { same($0, element) } == true })
    else { return false }
    let matches = structural.filter { same($0.element, element) }
    guard matches.count == 1, let node = matches.first,
      node.role == row["role"] as? String, let names = row["classes"] as? [String],
      node.classes.count == names.count, Set(node.classes) == Set(names)
    else { return false }
    if index == 0 {
      guard node.parent == nil else { return false }
    } else {
      guard let expectedParent = row["parent"] as? Int, let parent = captured[expectedParent],
        node.parent.map({ same($0, parent) }) == true
      else { return false }
    }
  }
  return true
}
func viewerDownloadTooltip(_ rows: [[String: Any]], subrole: String) -> Bool {
  downloadTooltipRows(rows, subrole: subrole, overlayLayer: "c-popover--z_menu")
}
func fileDetailsDownloadTooltip(_ rows: [[String: Any]], subrole: String) -> Bool {
  downloadTooltipRows(rows, subrole: subrole, overlayLayer: "c-popover--z_above_fs")
}
private func downloadTooltipRows(
  _ rows: [[String: Any]], subrole: String, overlayLayer: String
) -> Bool {
  guard subrole == "AXUserInterfaceTooltip", rows.count == 5 else { return false }
  let expectedClasses: [Set<String>] = [
    [
      "ReactModal__Overlay", "ReactModal__Overlay--after-open", "c-popover", overlayLayer,
      "c-popover--fade", "c-popover--no-pointer",
    ],
    ["ReactModal__Content", "ReactModal__Content--after-open", "popover", "c-popover__content"],
    ["c-tooltip__tip", "c-tooltip__tip--top", "c-tooltip__tip--small"], [],
    ["c-tooltip__tip__arrow"],
  ]
  let keys: Set<String> = [
    "index", "parent", "role", "classes", "id", "label", "AXTitle", "AXDescription", "AXHelp",
    "AXValue",
  ]
  for (index, row) in rows.enumerated() {
    guard Set(row.keys) == keys, row["index"] as? Int == index,
      index == 0 ? row["parent"] is NSNull : row["parent"] as? Int == [0, 0, 1, 2, 2][index],
      row["role"] as? String == (index == 3 ? "AXStaticText" : "AXGroup"),
      let names = row["classes"] as? [String], names.count == expectedClasses[index].count,
      Set(names) == expectedClasses[index],
      row["label"] as? String == ([1, 3].contains(index) ? "Download" : ""),
      row["AXTitle"] as? String == (index == 1 ? "Download" : ""),
      row["AXValue"] as? String == (index == 3 ? "Download" : ""),
      row["AXDescription"] as? String == "", row["AXHelp"] as? String == "",
      let identifier = row["id"] as? String,
      index == 1
        ? identifier.utf8.count <= 64
          && identifier.range(of: #"\Ask-tooltip-[0-9]+\z"#, options: .regularExpression) != nil
        : identifier.isEmpty
    else { return false }
  }
  return true
}
struct ViewerIsolationFailure: Error, CustomStringConvertible {
  let description: String
  let diagnostic: [String: Any]
}
func viewerIsolationStructure(_ capture: [String: Any]) -> [String: Any] {
  let rows = capture["nodes"] as? [[String: Any]] ?? []
  var fieldTruncated = false
  func bounded(_ value: String, limit: Int = 200) -> String {
    if value.count > limit { fieldTruncated = true }
    return String(value.prefix(limit))
  }
  let nodes: [[String: Any]] = rows.prefix(64).map { row in
    var result: [String: Any] = [:]
    for key in ["index", "parent"] { if let value = row[key] { result[key] = value } }
    for key in ["role", "id"] {
      if let value = row[key] as? String { result[key] = bounded(value) }
    }
    if let names = row["classes"] as? [String] {
      if names.count > 32 { fieldTruncated = true }
      result["classes"] = names.prefix(32).map { bounded($0) }
    }
    // Unknown dialogs can contain drafts or menu text. Only these fixed UI
    // labels are useful to distinguish the existing toast/tooltip allowlists.
    for key in ["label", "AXTitle"]
    where ["AXGroup", "AXButton", "AXStaticText"].contains(row["role"] as? String ?? "") {
      if let value = row[key] as? String, ["Download", "Recent downloads", "Close"].contains(value)
      {
        result[key] = value
      }
    }
    return result
  }
  return [
    "nodes": nodes, "capturedCount": rows.count, "returnedCount": nodes.count,
    "captureTruncated": capture["truncated"] as Any? ?? NSNull(),
    "nodesTruncated": rows.count > nodes.count, "fieldValuesTruncated": fieldTruncated,
    "structuralFieldsOnly": true,
  ]
}
func requireViewerIsolation(
  _ workspace: Workspace, _ owned: AXUIElement? = nil, sourceURL: String? = nil,
  detailsDownloadTooltip: (() throws -> Void)? = nil
) throws {
  try requireNoModal(workspace.window)
  let panels = try fileViewerPanels(workspace.root())
  try require(
    ownedSurfaceMatches(panels, owned),
    "An unrelated or ambiguous file viewer is open; no viewer input was requested")
  let modals = try tree(workspace.window).filter {
    classes($0.element).contains("ReactModal__Content")
  }
  var tooltipSeen = false
  for modal in modals {
    if let owned, CFEqual(modal.element, owned) { continue }
    var capturedElements: [Int: AXUIElement] = [:]
    let capture = try contentSnapshot(modal.element, onNode: { capturedElements[$0] = $1 })
    let subrole = string(modal.element, kAXSubroleAttribute)
    func rejected(
      _ reason: String, _ message: String = "Another modal appeared; viewer input withheld",
      overlay: [String: Any]? = nil, parentMatched: Bool? = nil
    ) -> ViewerIsolationFailure {
      var diagnostic: [String: Any] = [
        "reason": reason, "ownedViewerPresent": owned != nil,
        "ownedPanelCount": panels.count, "reactModalCount": modals.count,
        "modalMatchesOwned": owned.map { CFEqual($0, modal.element) } ?? false,
        "subrole": String(subrole.prefix(100)), "tooltipSeen": tooltipSeen,
        "modal": viewerIsolationStructure(capture),
      ]
      if let overlay { diagnostic["overlay"] = viewerIsolationStructure(overlay) }
      if let parentMatched { diagnostic["parentMatched"] = parentMatched }
      return ViewerIsolationFailure(description: message, diagnostic: diagnostic)
    }
    let modalRows = capture["nodes"] as! [[String: Any]]
    if viewerDownloadToast(modalRows, subrole: subrole) {
      if viewerTransientDownloadToast(modalRows, subrole: subrole) {
        // contentSnapshot deliberately omits editor subtrees. This separate
        // structural-only walk must account for every native identity/parent;
        // it never reads editor values or treats redaction as absence.
        let fresh = try tree(modal.element)
        let structural = fresh.map { node in
          ViewerToastStructuralNode(
            element: node.element, parent: node.parent >= 0 ? fresh[node.parent].element : nil,
            role: role(node.element), classes: classes(node.element))
        }
        guard capture["truncated"] as? Bool == false,
          viewerToastCaptureAccepted(
            modalRows, subrole: subrole, captured: capturedElements, structural: structural,
            same: { CFEqual($0, $1) })
        else { throw rejected("transient-toast-structure-changed") }
      }
      continue
    }
    guard !tooltipSeen,
      let parent = attr(modal.element, kAXParentAttribute),
      CFGetTypeID(parent) == AXUIElementGetTypeID()
    else { throw rejected("additional-tooltip-or-missing-parent") }
    var overlayElements: [Int: AXUIElement] = [:]
    let overlay = try contentSnapshot(parent as! AXUIElement, onNode: { overlayElements[$0] = $1 })
    guard overlay["truncated"] as? Bool == false else {
      throw rejected(
        "overlay-incomplete", "Viewer tooltip overlay capture is incomplete; input withheld",
        overlay: overlay)
    }
    let parentMatched = overlayElements[1].map { CFEqual($0, modal.element) } == true
    guard parentMatched else {
      throw rejected(
        "overlay-identity-changed", "Tooltip left its retained overlay; input withheld",
        overlay: overlay, parentMatched: false)
    }
    if let detailsDownloadTooltip {
      guard
        owned == nil && sourceURL == nil
          && fileDetailsDownloadTooltip(overlay["nodes"] as! [[String: Any]], subrole: subrole)
      else {
        throw rejected(
          "unsupported-details-tooltip", "Another modal appeared; file details input withheld",
          overlay: overlay, parentMatched: true)
      }
      try detailsDownloadTooltip()
      tooltipSeen = true
      continue
    }
    guard let owned, let sourceURL,
      viewerDownloadTooltip(overlay["nodes"] as! [[String: Any]], subrole: subrole)
    else { throw rejected("unsupported-viewer-tooltip", overlay: overlay, parentMatched: true) }
    var viewerElements: [Int: AXUIElement] = [:]
    let viewer = try contentSnapshot(owned, onNode: { viewerElements[$0] = $1 })
    guard viewer["truncated"] as? Bool == false,
      let target = viewerDownloadTarget(viewer["nodes"] as! [[String: Any]], sourceURL: sourceURL),
      let control = viewerElements[target.controlIndex],
      attr(control, kAXFocusedAttribute) as? Bool == true
    else {
      throw rejected(
        "tooltip-focused-control-unverified",
        "Download tooltip lacks its unique source-bound focused control", overlay: overlay,
        parentMatched: true)
    }
    tooltipSeen = true
  }
}
// Closing the owned viewer can expose one offscreen message-actions group.
// This exception is available only after Close; no Download capability is
// derived from pruned source rows, and ordinary source verification stays exact.
struct ViewerCloseSourceBaseline {
  let rows: [[String: Any]]
  let mediaIndex: Int
  var openingToolbarBaseline: ViewerToolbarVisibilityBaseline? = nil
}
func viewerActionToolbarMarker(_ row: [String: Any]) -> Bool {
  (row["classes"] as? [String] ?? []).contains {
    $0.hasPrefix("c-message_actions__") || $0.hasPrefix("c-message-actions--")
      || $0.hasPrefix("c-message__actions")
  }
}
func viewerRawSourceSignature(_ rows: [[String: Any]], _ rootIndex: Int) throws -> Data {
  let source = transcriptRawSourceRows(rows, rootIndex)
  try require(
    !source.isEmpty && source[0]["index"] as? Int == rootIndex,
    "Post-close source rows are unavailable")
  let indexes = Dictionary(
    uniqueKeysWithValues: source.enumerated().map { ($0.element["index"] as! Int, $0.offset) })
  let canonical = try source.map { row -> [String: Any] in
    var value = row
    let old = row["index"] as! Int
    value["index"] = indexes[old]!
    if old == rootIndex {
      value["parent"] = NSNull()
    } else {
      guard let parent = row["parent"] as? Int, let relative = indexes[parent] else {
        throw Failure(description: "Post-close source ancestry changed")
      }
      value["parent"] = relative
    }
    return value
  }
  return try JSONSerialization.data(withJSONObject: canonical, options: [.sortedKeys])
}
struct ViewerOffscreenToolbarNode {
  let parentOffset: Int
  let role: String
  let classes: [String]
  let label: String
  let state: String?
  let url: String?
}
func viewerOffscreenToolbarShapes(_ rootClasses: [String]) -> [[ViewerOffscreenToolbarNode]] {
  func node(
    _ parent: Int, _ role: String, _ classes: [String], _ label: String = "",
    state: String? = nil, url: String? = nil
  ) -> ViewerOffscreenToolbarNode {
    ViewerOffscreenToolbarNode(
      parentOffset: parent, role: role, classes: classes,
      label: label, state: state, url: url)
  }
  let group = ["c-message_actions__group", "c-message-actions--hover-actions"]
  let reaction = [
    "c-button--focus-visible", "c-button-unstyled", "c-message_actions__button",
    "c-message_actions__emoji_button",
  ]
  let button = [
    "c-button--focus-visible", "c-button-unstyled", "c-icon_button", "c-icon_button--size_smedium",
    "c-message_actions__button", "c-icon_button--default",
  ]
  let prefix = [node(-1, "AXGroup", rootClasses), node(0, "AXGroup", group, "Message actions")]
  func legacy(_ threadLabel: String?) -> [ViewerOffscreenToolbarNode] {
    var shape = prefix
    for (name, label, code) in [
      ("white_check_mark", "white check mark emoji", "2705"), ("eyes", "eyes emoji", "1f440"),
      ("raised_hands", "raised hands emoji", "1f64c"),
    ] {
      let parent = shape.count
      shape.append(node(1, "AXCheckBox", reaction, "React with \(name)", state: "0"))
      shape.append(
        node(
          parent, "AXImage", ["c-emoji", "c-emoji__small"], label,
          url:
            "https://a.slack-edge.com/production-standard-emoji-assets/16.0/apple-small/\(code)@2x.png"
        ))
    }
    shape.append(node(1, "AXButton", button, "Add reaction…", state: ""))
    if let threadLabel { shape.append(node(1, "AXButton", button, threadLabel, state: "")) }
    shape.append(node(1, "AXButton", button, "Forward message…", state: ""))
    shape.append(node(1, "AXButton", button, "Add to-do", state: ""))
    let wrapper = shape.count
    shape.append(node(1, "AXGroup", ["container__z3l0C"]))
    shape.append(node(wrapper, "AXButton", button, "Add to list…", state: ""))
    shape.append(
      node(
        1, "AXPopUpButton", button + ["c-message_actions__button--more"], "More actions", state: "")
    )
    return shape
  }
  // These are complete observed alternatives, not independently optional
  // controls. The compact Slackbot layout does not inherit legacy variants.
  let compact =
    prefix + [
      node(1, "AXGroup", ["container___lGTS"]),
      node(2, "AXButton", button, "Add reaction…", state: ""),
      node(1, "AXButton", button, "Reply in thread", state: ""),
      node(1, "AXButton", button, "Forward message…", state: ""),
      node(1, "AXButton", button, "Add to-do", state: ""),
      node(1, "AXPopUpButton", button, "Ask Slackbot", state: ""),
      node(
        1, "AXPopUpButton", button + ["c-message_actions__button--more"], "More actions", state: ""),
    ]
  var compactWithoutThread = compact
  compactWithoutThread.remove(at: 4)
  return [
    legacy("Reply in thread"), legacy("Reply to thread"), legacy("View thread"), legacy(nil),
    compact, compactWithoutThread,
  ]
}

func viewerMatchedToolbar(
  _ rows: [[String: Any]], rootIndex: Int, mediaIndex: Int,
  rootClasses: [String], shapes: [[ViewerOffscreenToolbarNode]]
) -> Set<Int>? {
  let source = transcriptRawSourceRows(rows, rootIndex)
  guard let root = source.first, root["role"] as? String == "AXGroup",
    (root["classes"] as? [String] ?? []).contains("c-message_kit__actions"),
    mediaIndex != rootIndex, source.contains(where: { $0["index"] as? Int == mediaIndex })
  else { return nil }
  let rootMarkers = Set(rootClasses)
  let candidates = source.filter { !rootMarkers.isDisjoint(with: $0["classes"] as? [String] ?? []) }
  guard candidates.count == 1, let toolbarIndex = candidates[0]["index"] as? Int,
    candidates[0]["parent"] as? Int == rootIndex,
    !transcriptRawSourceRows(source, mediaIndex).contains(where: {
      $0["index"] as? Int == toolbarIndex
    })
  else { return nil }
  let toolbar = transcriptRawSourceRows(source, toolbarIndex)
  let shapes = shapes.filter { $0.count == toolbar.count }
  guard !shapes.isEmpty else { return nil }
  let indexes = toolbar.compactMap { $0["index"] as? Int }
  guard indexes.count == toolbar.count, Set(indexes).count == toolbar.count else { return nil }
  let owned = Set(indexes)
  guard source.filter(viewerActionToolbarMarker).allSatisfy({ owned.contains($0["index"] as! Int) })
  else { return nil }
  // Match one whole observed shape. Every field, parent and child order remains
  // checked, including exact standard emoji URLs only in legacy layouts.
  let plain: Set<String> = [
    "index", "parent", "role", "classes", "id", "label", "AXTitle", "AXDescription", "AXValue",
    "AXHelp",
  ]
  func exact(_ offset: Int, _ expected: ViewerOffscreenToolbarNode) -> Bool {
    let row = toolbar[offset]
    let parent = expected.parentOffset == -1 ? rootIndex : indexes[expected.parentOffset]
    var keys = plain
    if expected.state != nil { keys.formUnion(["stateValue", "selected"]) }
    if expected.url != nil { keys.insert("url") }
    guard Set(row.keys) == keys, row["parent"] as? Int == parent,
      row["role"] as? String == expected.role,
      (row["classes"] as? [String])?.sorted() == expected.classes.sorted(),
      row["id"] as? String == "", row["label"] as? String == expected.label,
      row["AXTitle"] as? String == expected.label,
      row["AXDescription"] as? String == expected.label,
      row["AXValue"] as? String == "", row["AXHelp"] as? String == ""
    else { return false }
    if let state = expected.state {
      guard row["stateValue"] as? String == state, row["selected"] as? Bool == false else {
        return false
      }
    }
    return expected.url == nil || row["url"] as? String == expected.url
  }
  guard
    shapes.contains(where: { shape in shape.enumerated().allSatisfy { exact($0.offset, $0.element) }
    })
  else { return nil }
  return owned
}
func viewerAddedOffscreenToolbar(
  _ rows: [[String: Any]], rootIndex: Int, mediaIndex: Int
) -> Set<Int>? {
  let rootClasses = [
    "c-message_actions__container", "c-message__actions", "c-message__actions--offscreen",
  ]
  return viewerMatchedToolbar(
    rows, rootIndex: rootIndex, mediaIndex: mediaIndex, rootClasses: rootClasses,
    shapes: viewerOffscreenToolbarShapes(rootClasses))
}
func viewerFileToolbar(
  _ rows: [[String: Any]], rootIndex: Int, mediaIndex: Int, offscreen: Bool
) -> Set<Int>? {
  let rootClasses =
    ["c-message_actions__container", "c-message__actions"]
    + (offscreen ? ["c-message__actions--offscreen"] : [])
  func node(_ parent: Int, _ role: String, _ names: [String], _ label: String = "")
    -> ViewerOffscreenToolbarNode
  {
    ViewerOffscreenToolbarNode(
      parentOffset: parent, role: role, classes: names, label: label,
      state: ["AXButton", "AXPopUpButton"].contains(role) ? "" : nil, url: nil)
  }
  let button = [
    "c-button--focus-visible", "c-button-unstyled", "c-icon_button", "c-icon_button--size_smedium",
    "c-message_actions__button", "c-icon_button--default",
  ]
  let shape = [
    node(-1, "AXGroup", rootClasses),
    node(
      0, "AXGroup", ["c-message_actions__group", "c-message-actions--hover-actions"],
      "Message actions"),
    node(1, "AXGroup", ["container___lGTS"]),
    node(2, "AXButton", button, "Add reaction…"),
    node(1, "AXButton", button, "Reply in thread"),
    node(1, "AXButton", button, "Forward file…"),
    node(1, "AXButton", button, "Add to-do"),
    node(1, "AXPopUpButton", button, "Ask Slackbot"),
    node(1, "AXPopUpButton", button + ["c-message_actions__button--more"], "More actions"),
  ]
  return viewerMatchedToolbar(
    rows, rootIndex: rootIndex, mediaIndex: mediaIndex, rootClasses: rootClasses, shapes: [shape])
}
struct ViewerToolbarVisibilityBaseline {
  let element: AXUIElement
  let rows: [[String: Any]]
  let mediaIndex: Int
}
func viewerToolbarBecameOffscreen(
  _ rows: [[String: Any]], mediaIndex: Int, originalSignature: Data,
  baseline: ViewerToolbarVisibilityBaseline
) throws -> Bool {
  let source = transcriptRawSourceRows(rows, 0)
  guard mediaIndex == baseline.mediaIndex,
    source.firstIndex(where: { $0["index"] as? Int == mediaIndex }) == baseline.mediaIndex,
    let baselineMedia = baseline.rows.first(where: { $0["index"] as? Int == baseline.mediaIndex }),
    baselineMedia["role"] as? String == "AXGroup",
    ["p-message_gallery_image_file", "c-file_gallery_image_file"].allSatisfy({
      (baselineMedia["classes"] as? [String] ?? []).contains($0)
    }),
    let before = viewerFileToolbar(
      baseline.rows, rootIndex: 0, mediaIndex: baseline.mediaIndex, offscreen: false),
    try transcriptSourceSignature(baseline.rows, 0, selectedMediaIndex: baseline.mediaIndex)
      == originalSignature,
    let after = viewerFileToolbar(rows, rootIndex: 0, mediaIndex: mediaIndex, offscreen: true),
    let toolbar = rows.first(where: {
      $0["parent"] as? Int == 0 && after.contains($0["index"] as! Int)
    }), before.count == after.count
  else { return false }
  let toolbarIndex = toolbar["index"] as! Int
  let restored = rows.map { row -> [String: Any] in
    guard row["index"] as? Int == toolbarIndex else { return row }
    var value = row
    value["classes"] = (row["classes"] as! [String]).filter {
      $0 != "c-message__actions--offscreen"
    }
    return value
  }
  return try viewerRawSourceSignature(restored, 0) == viewerRawSourceSignature(baseline.rows, 0)
}
func viewerSourceCheck(
  _ rows: [[String: Any]], mediaIndex: Int, originalSignature: Data,
  postCloseBaseline: ViewerCloseSourceBaseline? = nil,
  openingToolbarBaseline: ViewerToolbarVisibilityBaseline? = nil
) throws -> String? {
  if try transcriptSourceSignature(rows, 0, selectedMediaIndex: mediaIndex) == originalSignature {
    return "unchanged"
  }
  if postCloseBaseline == nil, let openingToolbarBaseline,
    try viewerToolbarBecameOffscreen(
      rows, mediaIndex: mediaIndex, originalSignature: originalSignature,
      baseline: openingToolbarBaseline)
  {
    return "existing-toolbar-offscreen"
  }
  if let baseline = postCloseBaseline, let opening = baseline.openingToolbarBaseline,
    try viewerToolbarBecameOffscreen(
      baseline.rows, mediaIndex: baseline.mediaIndex, originalSignature: originalSignature,
      baseline: opening),
    try viewerRawSourceSignature(rows, 0) == viewerRawSourceSignature(baseline.rows, 0)
  {
    return "retained-offscreen-toolbar"
  }
  guard let baseline = postCloseBaseline,
    !baseline.rows.contains(where: viewerActionToolbarMarker),
    try transcriptSourceSignature(baseline.rows, 0, selectedMediaIndex: baseline.mediaIndex)
      == originalSignature,
    let addition = viewerAddedOffscreenToolbar(rows, rootIndex: 0, mediaIndex: mediaIndex)
  else { return nil }
  let remaining = rows.filter { !addition.contains($0["index"] as! Int) }
  guard try viewerRawSourceSignature(remaining, 0) == viewerRawSourceSignature(baseline.rows, 0)
  else { return nil }
  return "added-offscreen-toolbar"
}

func verifyViewerSource(
  _ selected: ViewerOpenerCandidate, _ workspace: Workspace,
  ownedViewer: AXUIElement? = nil, postCloseBaseline: ViewerCloseSourceBaseline? = nil
) throws -> [String: Any] {
  try require(
    postCloseBaseline == nil || ownedViewer == nil,
    "Post-close source exception requires no owned viewer")
  try requireViewerIsolation(workspace, ownedViewer, sourceURL: selected.target.sourceURL)
  let root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Search picker appeared; viewer input withheld")
  let nodes = try tree(root)
  try require(
    nodes.contains { CFEqual($0.element, selected.container) }
      && nodes.contains { CFEqual($0.element, selected.media) }
      && nodes.contains { CFEqual($0.element, selected.control) },
    "Original viewer source disappeared")
  if let ownedViewer {
    let viewerNodes = try tree(ownedViewer)
    try require(
      !viewerNodes.contains {
        CFEqual($0.element, selected.container) || CFEqual($0.element, selected.media)
      },
      "Original source moved inside the viewer; cloned source is not accepted")
  }
  var mediaIndex: Int?
  var controlIndex: Int?
  var toolbarIndexes: [Int] = []
  let capture = try contentSnapshot(
    selected.container,
    onNode: { index, element in
      if CFEqual(element, selected.media) { mediaIndex = index }
      if CFEqual(element, selected.control) { controlIndex = index }
      if let baseline = selected.toolbarBaseline, CFEqual(element, baseline.element) {
        toolbarIndexes.append(index)
      }
    })
  let rows = capture["nodes"] as! [[String: Any]]
  try require(
    mediaIndex != nil && controlIndex != nil,
    "Retained viewer source ancestry changed")
  let targets = viewerOpenerTargets(
    rows, contextId: workspace.context.split(separator: "/").last.map(String.init))
  try require(
    targets.contains {
      $0.containerIndex == 0 && $0.mediaIndex == mediaIndex
        && $0.controlIndex == controlIndex
        && $0.sourceURL.utf8.elementsEqual(selected.target.sourceURL.utf8)
        && $0.identity.fileId == selected.target.identity.fileId
        && $0.identity.ownerTeamId == selected.target.identity.ownerTeamId
    },
    "Viewer opener role, URL or source ownership changed")
  let retainedToolbarBaseline: ViewerToolbarVisibilityBaseline?
  if let baseline = selected.toolbarBaseline, toolbarIndexes.count == 1,
    rows.first(where: { $0["index"] as? Int == toolbarIndexes[0] })?["parent"] as? Int == 0,
    captureParentEquals(baseline.element, selected.container)
  {
    retainedToolbarBaseline = baseline
  } else {
    retainedToolbarBaseline = nil
  }
  try require(
    postCloseBaseline?.openingToolbarBaseline == nil || retainedToolbarBaseline != nil,
    "Retained message toolbar identity or parent changed after viewer closure")
  guard
    let sourceCheck = try viewerSourceCheck(
      rows, mediaIndex: mediaIndex!,
      originalSignature: selected.signature, postCloseBaseline: postCloseBaseline,
      openingToolbarBaseline: ownedViewer == nil ? nil : retainedToolbarBaseline)
  else {
    throw Failure(description: "Viewer source message/media identity or order changed")
  }
  try require(
    try transcriptPlayback(selected.media).isEmpty,
    "Image source unexpectedly exposes playback controls; viewer input withheld")
  var result: [String: Any] = [
    "content": capture, "mediaIndex": mediaIndex!, "controlIndex": controlIndex!,
  ]
  if postCloseBaseline != nil || sourceCheck == "existing-toolbar-offscreen" {
    result["sourceCheck"] = sourceCheck
  }
  return result
}
struct ViewerDownloadCapture {
  let observation: [String: Any]
  let target: ViewerDownloadTarget
  let elements: [Int: AXUIElement]
  func sourceSignature() throws -> Data {
    guard let source = observation["source"] as? [String: Any],
      let content = source["content"] as? [String: Any], content["truncated"] as? Bool == false,
      let rows = content["nodes"] as? [[String: Any]]
    else { throw Failure(description: "Viewer source capture is incomplete") }
    return try viewerRawSourceSignature(rows, 0)
  }
}
func captureViewerDownload(
  _ selected: ViewerOpenerCandidate, _ viewer: AXUIElement,
  _ workspace: Workspace
) throws -> ViewerDownloadCapture {
  let before = identity(try workspace.root())
  let source = try verifyViewerSource(selected, workspace, ownedViewer: viewer)
  var elements: [Int: AXUIElement] = [:]
  let content = try contentSnapshot(viewer, onNode: { elements[$0] = $1 })
  let capturedAt = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
  guard
    content["truncated"] as? Bool == false,
    let target = viewerDownloadTarget(
      content["nodes"] as! [[String: Any]], sourceURL: selected.target.sourceURL)
  else {
    throw ViewerVerificationFailure(
      description: "Viewer has no unique source-matched image Download control",
      diagnostic: viewerFailureDiagnostic(
        content: content, sourceURL: selected.target.sourceURL,
        contextId: workspace.context.split(separator: "/").last.map(String.init),
        phase: "capture",
        reason: content["truncated"] as? Bool == false
          ? "source-or-layout-unverified" : "incomplete-capture", capturedAt: capturedAt))
  }
  let after = identity(try workspace.root())
  try require(
    before["url"] as? String == after["url"] as? String
      && before["title"] as? String == after["title"] as? String,
    "Viewer workspace view changed during capture")
  return ViewerDownloadCapture(
    observation: ["before": before, "after": after, "source": source, "content": content],
    target: target, elements: elements)
}
struct ViewerDownloadCandidate {
  let token: String
  let opener: ViewerOpenerCandidate
  let viewer: AXUIElement
  let branch: AXUIElement
  let media: AXUIElement
  let image: AXUIElement
  let footer: AXUIElement
  let control: AXUIElement
  let close: AXUIElement
  let closeParent: AXUIElement
  let target: ViewerDownloadTarget
  let sourceSignature: Data
  var receipt: [String: Any] {
    [
      "token": token, "scope": "viewer", "openerToken": opener.token,
      "viewerIndex": target.viewerIndex, "branchIndex": target.branchIndex,
      "mediaIndex": target.mediaIndex, "imageIndex": target.imageIndex,
      "footerIndex": target.footerIndex, "controlIndex": target.controlIndex,
      "sourceURL": opener.target.sourceURL, "fileId": opener.target.identity.fileId,
      "ownerTeamId": opener.target.identity.ownerTeamId, "url": NSNull(), "routeKind": "unknown",
    ]
  }
  func verify(_ capture: ViewerDownloadCapture) throws {
    try require(
      try capture.sourceSignature() == sourceSignature,
      "Retained viewer source changed between captures")
    let target = capture.target
    for (index, element) in [
      (target.viewerIndex, viewer), (target.branchIndex, branch),
      (target.mediaIndex, media), (target.imageIndex, image), (target.footerIndex, footer),
      (target.controlIndex, control), (target.closeIndex, close),
      (target.closeParentIndex, closeParent),
    ] {
      try require(
        capture.elements[index].map { CFEqual($0, element) } == true,
        "Retained viewer control or active image identity changed")
    }
  }
}
func viewerRequest(_ data: Data, _ allowed: Set<String>) throws -> String? {
  try require(data.count <= 4096, "Viewer selection exceeds bounds; no viewer input performed")
  guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    value["openViewer"] != nil
  else { return nil }
  try require(
    value.count == 1 && (value["openViewer"] as? String).map { allowed.contains($0) } == true,
    "Viewer selection was cancelled or unverified; no viewer input performed")
  return value["openViewer"] as? String
}
func closeOwnedViewer(
  _ selected: ViewerDownloadCandidate, _ workspace: Workspace, beforePress: () throws -> Void
) throws -> String {
  let capture = try captureViewerDownload(selected.opener, selected.viewer, workspace)
  try selected.verify(capture)
  guard let source = capture.observation["source"] as? [String: Any],
    let content = source["content"] as? [String: Any], content["truncated"] as? Bool == false,
    let rows = content["nodes"] as? [[String: Any]], let mediaIndex = source["mediaIndex"] as? Int
  else { throw Failure(description: "Pre-close source baseline is incomplete; Close withheld") }
  let baseline = ViewerCloseSourceBaseline(
    rows: rows, mediaIndex: mediaIndex,
    openingToolbarBaseline: source["sourceCheck"] as? String == "existing-toolbar-offscreen"
      ? selected.opener.toolbarBaseline : nil)
  let window = try windowId(workspace.window, workspace.pid)
  try sampleDesktop("before-owned-viewer-close")
  try require(
    attr(selected.close, kAXEnabledAttribute) as? Bool == true
      && actions(selected.close).contains(kAXPressAction),
    "Viewer close control is disabled or lacks AXPress")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: {
      try requireViewerIsolation(
        workspace, selected.viewer, sourceURL: selected.opener.target.sourceURL)
    },
    input: {
      try beforePress()
      try press(selected.close)
    })
  let deadline = Date().addingTimeInterval(4)
  repeat {
    settle()
    try sampleDesktop("verify-owned-viewer-close")
    if try fileViewerPanels(workspace.root()).isEmpty {
      let result = try verifyViewerSource(selected.opener, workspace, postCloseBaseline: baseline)
      guard let sourceCheck = result["sourceCheck"] as? String else {
        throw Failure(description: "Post-close source verification evidence is unavailable")
      }
      return sourceCheck
    }
  } while Date() < deadline
  throw Failure(
    description:
      "Viewer close was attempted once but closure was not verified; inspect before retry")
}

// File details opens only through an explicit source-owned "View file details"
// button or the owned video's More actions -> View details menu item. Filename,
// thumbnail and playback actions never substitute for these guarded controls.
func detailsFilePageID(_ value: String, contextId: String?) -> String? {
  guard value.utf8.count <= 16384,
    let expression = try? NSRegularExpression(
      pattern:
        #"\Ahttps://(?:[a-z0-9-]+\.)*slack\.com/files/U[A-Z0-9]+/(F[A-Z0-9]+)/([A-Za-z0-9._~!$&'()*+,;=:@%\-]+)(?:\?origin_team=([TE][A-Z0-9]+))?\z"#
    ),
    let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
    let fileRange = Range(match.range(at: 1), in: value),
    let nameRange = Range(match.range(at: 2), in: value),
    let name = String(value[nameRange]).removingPercentEncoding,
    !name.isEmpty, ![".", ".."].contains(name), !name.contains("/"), !name.contains("\\"),
    !name.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) })
  else { return nil }
  if match.range(at: 3).location != NSNotFound {
    guard let range = Range(match.range(at: 3), in: value), String(value[range]) == contextId else {
      return nil
    }
  }
  return String(value[fileRange])
}
func detailsMediaKind(_ row: [String: Any]) -> String? {
  let names = Set(row["classes"] as? [String] ?? [])
  guard row["role"] as? String == "AXGroup" else { return nil }
  if names.contains("p-search_file--audio-player") || detailsAudioRoot(row) { return "audio" }
  if names.contains("p-video_message_file") { return "video" }
  if !names.isDisjoint(with: ["p-message_gallery_image_file", "c-file_gallery_image_file"]) {
    return nil
  }
  return names.isDisjoint(with: ["c-pillow_file_container", "p-message_file"]) ? nil : "file"
}
func detailsAudioRoot(_ row: [String: Any]) -> Bool {
  let names = Set(row["classes"] as? [String] ?? [])
  return row["role"] as? String == "AXGroup" && names.contains("c-pillow_file_container")
    && (names.contains("p-search_file--audio-player")
      || (names.contains("p-message_file") && names.contains("p-message_file--audio_message")))
}
func detailsAudioIdentityRows(_ rows: [[String: Any]], _ mediaIndex: Int) -> [[String: Any]] {
  guard let root = rows.first(where: { $0["index"] as? Int == mediaIndex }), detailsAudioRoot(root)
  else { return [] }
  let scoped = transcriptRawSourceRows(rows, mediaIndex)
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func owned(_ row: [String: Any]) -> Bool {
    var parent = row
    while let index = parent["parent"] as? Int, index != mediaIndex, let next = indexed[index] {
      if detailsMediaKind(next) != nil
        || (next["classes"] as? [String] ?? []).contains("c-message_kit__actions")
        || ["AXTextArea", "AXTextField"].contains(next["role"] as? String ?? "")
        || (next["classes"] as? [String] ?? []).contains(where: {
          $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
        })
      {
        return false
      }
      parent = next
    }
    return true
  }
  guard
    scoped.contains(where: {
      $0["role"] as? String == "AXCheckBox"
        && ($0["classes"] as? [String] ?? []).contains("c-audio_player_play_button") && owned($0)
    })
  else { return [] }
  return scoped.filter { row in
    row["role"] as? String == "AXGroup" && (row["classes"] as? [String] ?? []).contains("sr-only")
      && (row["id"] as? String)?.range(
        of: #"\Atranscript-description-F[A-Z0-9]+\z"#, options: .regularExpression) != nil
      && owned(row)
  }
}
func detailsVideoIdentityRows(_ rows: [[String: Any]], _ mediaIndex: Int) -> [[String: Any]] {
  guard let root = rows.first(where: { $0["index"] as? Int == mediaIndex }),
    root["role"] as? String == "AXGroup",
    (root["classes"] as? [String] ?? []).contains("p-video_message_file"),
    (root["classes"] as? [String] ?? []).contains("p-video_message_file--gallery_v3")
  else { return [] }
  let scoped = transcriptRawSourceRows(rows, mediaIndex)
  guard
    !scoped.dropFirst().contains(where: {
      detailsMediaKind($0) != nil
        || ($0["classes"] as? [String] ?? []).contains("c-message_kit__actions")
    }),
    scoped.contains(where: {
      $0["role"] as? String == "AXCheckBox" && ($0["label"] as? String ?? "").hasPrefix("Play")
    })
  else { return [] }
  return scoped.filter {
    $0["role"] as? String == "AXGroup" && ($0["classes"] as? [String] ?? []).contains("sr-only")
      && ($0["id"] as? String)?.range(
        of: #"\Acaption-description-F[A-Z0-9]+\z"#, options: .regularExpression) != nil
  }
}
func detailsFileIDs(_ rows: [[String: Any]], _ mediaIndex: Int) -> Set<String>? {
  guard var ids = transcriptVideoFileIds(rows, mediaIndex),
    let root = rows.first(where: { $0["index"] as? Int == mediaIndex })
  else { return nil }
  // A source or details audio player can expose a canonical owned transcript ID.
  if detailsAudioRoot(root) {
    for row in detailsAudioIdentityRows(rows, mediaIndex) {
      ids.insert(String((row["id"] as! String).dropFirst("transcript-description-".count)))
    }
  }
  return ids
}
struct FileDetailsMenuTarget {
  let openerIndex: Int
  let popoverIndex: Int
  let menuIndex: Int
  let controlIndex: Int
}
func fileDetailsVideoMenuTarget(_ rows: [[String: Any]], cornerIndex: Int = 0)
  -> FileDetailsMenuTarget?
{
  func has(_ row: [String: Any], _ name: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(name)
  }
  func children(_ index: Int) -> [[String: Any]] { rows.filter { $0["parent"] as? Int == index } }
  guard let corner = rows.first(where: { $0["index"] as? Int == cornerIndex }),
    corner["role"] as? String == "AXGroup",
    has(corner, "p-video_controls_overlay__corner"),
    has(corner, "p-video_controls_overlay__corner--gallery_v3")
  else { return nil }
  let openers = children(cornerIndex).filter {
    $0["role"] as? String == "AXPopUpButton" && $0["label"] as? String == "More actions"
      && has($0, "p-video_message_file--gallery_v3__controls_overlay_ellipsis")
      && has($0, "p-video_controls_overlay__corner_button")
  }
  let popovers = children(cornerIndex).filter {
    $0["role"] as? String == "AXGroup" && has($0, "ReactModal__Content")
      && has($0, "ReactModal__Content--after-open")
      && has($0, "popover") && has($0, "c-popover__content") && !($0["id"] as? String ?? "").isEmpty
  }
  guard openers.count == 1, popovers.count == 1,
    let openerIndex = openers[0]["index"] as? Int, let popoverIndex = popovers[0]["index"] as? Int
  else { return nil }
  let menus = children(popoverIndex).filter {
    $0["role"] as? String == "AXMenu" && has($0, "c-menu__items")
  }
  guard menus.count == 1, children(popoverIndex).count == 1,
    let menuIndex = menus[0]["index"] as? Int
  else { return nil }
  let menuRows = transcriptRawSourceRows(rows, menuIndex)
  let items = children(menuIndex).filter {
    $0["role"] as? String == "AXMenuItem" && has($0, "c-menu_item__button") && $0["url"] == nil
  }
  let labels = items.compactMap { $0["label"] as? String }
  let allowed = Set([
    "Download", "Share file…", "Copy link", "Open in", "View details", "Add to section",
  ])
  guard items.count == 6, Set(labels) == allowed, labels.count == Set(labels).count,
    children(menuIndex).count == 8,
    children(menuIndex).filter({
      $0["role"] as? String == "AXSplitter" && has($0, "c-menu_separator__separator")
    }).count == 2,
    menuRows.dropFirst().allSatisfy({
      ["AXMenuItem", "AXGroup", "AXStaticText", "AXSplitter"].contains($0["role"] as? String ?? "")
    }),
    let details = items.first(where: { $0["label"] as? String == "View details" }),
    let controlIndex = details["index"] as? Int
  else { return nil }
  return FileDetailsMenuTarget(
    openerIndex: openerIndex, popoverIndex: popoverIndex, menuIndex: menuIndex,
    controlIndex: controlIndex)
}
struct FileDetailsOwnedMenu {
  let corner: AXUIElement
  let popover: AXUIElement
  let menu: AXUIElement
  let details: AXUIElement
  let target: FileDetailsMenuTarget
}
func fileDetailsOwnedMenuMatches(
  _ owned: FileDetailsOwnedMenu, nodes: [AXUIElement],
  roleOf: (AXUIElement) -> String = role,
  parentEquals: (AXUIElement, AXUIElement) -> Bool = captureParentEquals
) -> Bool {
  let menus = nodes.filter { roleOf($0) == "AXMenu" }
  guard ownedSurfaceMatches(menus, owned.menu) else { return false }
  for (element, expectedRole) in [
    (owned.corner, "AXGroup"), (owned.popover, "AXGroup"), (owned.details, "AXMenuItem"),
  ] {
    guard roleOf(element) == expectedRole,
      nodes.filter({ CFEqual($0, element) }).count == 1
    else { return false }
  }
  return parentEquals(owned.details, owned.menu) && parentEquals(owned.menu, owned.popover)
    && parentEquals(owned.popover, owned.corner)
}
func requireFileDetailsMenuIsolation(_ workspace: Workspace, _ owned: FileDetailsOwnedMenu) throws {
  let nodes = try tree(workspace.window)
  try require(
    fileDetailsOwnedMenuMatches(owned, nodes: nodes.map { $0.element }),
    "Owned video details menu disappeared or changed ancestry; selection withheld")
  for node in nodes
  where ["AXDialog", "AXSheet", "AXMenu"].contains(role(node.element))
    || string(node.element, kAXSubroleAttribute) == "AXDialog"
    || (attr(node.element, "AXModal") as? Bool) == true
  {
    try require(
      CFEqual(node.element, owned.menu),
      "Unrelated dialog or menu appeared during video details opening")
  }
  try require(
    try fileViewerPanels(workspace.root()).isEmpty && fileDetailsPanels(workspace.root()).isEmpty,
    "Another file surface appeared while selecting video details")
  for node in nodes where classes(node.element).contains("ReactModal__Content") {
    if CFEqual(node.element, owned.popover) { continue }
    let capture = try contentSnapshot(node.element)
    try require(
      viewerDownloadToast(
        capture["nodes"] as! [[String: Any]], subrole: string(node.element, kAXSubroleAttribute)),
      "Unrelated modal appeared during video details selection")
  }
}
func fileDetailsMenuSourceRows(_ rows: [[String: Any]], mediaIndex: Int, controlIndex: Int) throws
  -> [[String: Any]]
{
  guard let control = rows.first(where: { $0["index"] as? Int == controlIndex }),
    let cornerIndex = control["parent"] as? Int,
    let corner = rows.first(where: { $0["index"] as? Int == cornerIndex }),
    let overlayIndex = corner["parent"] as? Int,
    let overlay = rows.first(where: { $0["index"] as? Int == overlayIndex }),
    overlay["parent"] as? Int == mediaIndex,
    (overlay["classes"] as? [String] ?? []).contains("p-video_controls_overlay"),
    let menu = fileDetailsVideoMenuTarget(rows, cornerIndex: cornerIndex),
    menu.openerIndex == controlIndex
  else {
    throw Failure(description: "Video details menu left its retained source corner")
  }
  let omitted = Set(
    transcriptRawSourceRows(rows, menu.popoverIndex).compactMap { $0["index"] as? Int })
  return rows.filter { !omitted.contains($0["index"] as! Int) }.map { row in
    var value = row
    if row["index"] as? Int == overlayIndex {
      value["classes"] = (row["classes"] as? [String] ?? []).filter {
        $0 != "p-video_controls_overlay--active"
      }
    }
    return value
  }
}
func captureFileDetailsMenu(
  _ selected: FileDetailsOpenerCandidate, _ corner: AXUIElement, _ workspace: Workspace,
  retained: FileDetailsOwnedMenu? = nil
) throws -> (FileDetailsOwnedMenu, [String: Any]) {
  var elements: [Int: AXUIElement] = [:]
  let content = try contentSnapshot(corner, onNode: { elements[$0] = $1 })
  guard let target = fileDetailsVideoMenuTarget(content["nodes"] as! [[String: Any]]),
    let opener = elements[target.openerIndex], CFEqual(opener, selected.control),
    let popover = elements[target.popoverIndex], let menu = elements[target.menuIndex],
    let details = elements[target.controlIndex]
  else {
    throw Failure(description: "No source-owned video View details menu item verified")
  }
  let owned = FileDetailsOwnedMenu(
    corner: corner, popover: popover, menu: menu, details: details, target: target)
  if let retained {
    for (a, b) in [
      (corner, retained.corner), (popover, retained.popover), (menu, retained.menu),
      (details, retained.details),
    ] {
      try require(CFEqual(a, b), "Retained video details menu identity changed")
    }
  }
  let source = try verifyFileDetailsSource(selected, workspace, ownedMenu: owned)
  return (
    owned,
    [
      "source": source, "content": content, "menuIndex": target.menuIndex,
      "controlIndex": target.controlIndex, "openerIndex": target.openerIndex,
    ]
  )
}

struct FileDetailsOpenerTarget {
  let openerKind: String
  let containerIndex: Int
  let mediaIndex: Int
  let controlIndex: Int
  let filePageIndex: Int?
  let filePageURL: String?
  let fileId: String
  let mediaKind: String
}
func fileDetailsOpenerTargets(_ rows: [[String: Any]], contextId: String?)
  -> [FileDetailsOpenerTarget]
{
  let indexed = Dictionary(uniqueKeysWithValues: rows.map { ($0["index"] as! Int, $0) })
  func has(_ row: [String: Any], _ name: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(name)
  }
  var result: [FileDetailsOpenerTarget] = []
  for media in rows {
    guard let kind = detailsMediaKind(media), let mediaIndex = media["index"] as? Int else {
      continue
    }
    let scoped = transcriptRawSourceRows(rows, mediaIndex)
    guard
      !scoped.dropFirst().contains(where: {
        detailsMediaKind($0) != nil || has($0, "c-message_kit__actions")
          || ["AXTextArea", "AXTextField"].contains($0["role"] as? String ?? "")
          || ($0["classes"] as? [String] ?? []).contains(where: {
            $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
          })
      }),
      !scoped.contains(where: {
        downloadLabel($0["label"] as? String ?? "")
          && ["AXLink", "AXButton", "AXMenuItem", "AXPopUpButton"].contains(
            $0["role"] as? String ?? "")
      }), let ids = detailsFileIDs(rows, mediaIndex), ids.count == 1, let fileId = ids.first
    else { continue }
    let buttons = scoped.filter { row in
      row["role"] as? String == "AXButton" && row["label"] as? String == "View file details"
        && row["url"] == nil && has(row, "c-message_actions__button")
        && (row["parent"] as? Int).flatMap({ indexed[$0] }).map({
          has($0, "c-file__actions") && has($0, "c-message_actions__container")
            && has($0, "c-message_actions__group")
        }) == true
    }
    let menus = scoped.filter { row in
      kind == "video" && has(media, "p-video_message_file--gallery_v3")
        && row["role"] as? String == "AXPopUpButton" && row["label"] as? String == "More actions"
        && row["url"] == nil
        && has(row, "p-video_message_file--gallery_v3__controls_overlay_ellipsis")
        && has(row, "p-video_controls_overlay__corner_button")
        && (row["parent"] as? Int).flatMap({ indexed[$0] }).map({ parent in
          parent["role"] as? String == "AXGroup" && has(parent, "p-video_controls_overlay__corner")
            && has(parent, "p-video_controls_overlay__corner--gallery_v3")
            && (parent["parent"] as? Int).flatMap({ indexed[$0] }).map({
              has($0, "p-video_controls_overlay") && $0["parent"] as? Int == mediaIndex
            }) == true
        }) == true
    }
    let controls = buttons + menus
    guard controls.count == 1, let controlIndex = controls[0]["index"] as? Int else { continue }
    let openerKind = menus.isEmpty ? "details-button" : "video-menu"
    let links = scoped.filter {
      $0["role"] as? String == "AXLink"
        && ($0["url"] as? String).flatMap { detailsFilePageID($0, contextId: contextId) } != nil
    }
    guard links.count <= 1,
      links.allSatisfy({ detailsFilePageID($0["url"] as! String, contextId: contextId) == fileId })
    else { continue }
    // A generic document card needs its observed page link; only an explicit
    // player identity can support an absent page link.
    guard kind != "file" || links.count == 1 else { continue }
    var parent = media
    var container: Int?
    var blocked = false
    for _ in 0..<40 {
      if ["AXTextArea", "AXTextField"].contains(parent["role"] as? String ?? "")
        || (parent["classes"] as? [String] ?? []).contains(where: {
          $0.hasPrefix("p-composer") || $0.hasPrefix("p-message_input")
            || $0 == "p-media_viewer_modal" || $0 == "p-view_contents--secondary"
        })
      {
        blocked = true
        break
      }
      if has(parent, "c-message_kit__actions") {
        container = parent["index"] as? Int
        break
      }
      guard let index = parent["parent"] as? Int, let next = indexed[index] else { break }
      parent = next
    }
    guard !blocked, let container else { continue }
    result.append(
      FileDetailsOpenerTarget(
        openerKind: openerKind, containerIndex: container, mediaIndex: mediaIndex,
        controlIndex: controlIndex, filePageIndex: links.first?["index"] as? Int,
        filePageURL: links.first?["url"] as? String, fileId: fileId, mediaKind: kind))
  }
  return result
}
func fileDetailsPlayback(_ media: AXUIElement, required: Bool) throws -> [[String: Any]] {
  let nodes = try tree(media)
  try require(
    !nodes.contains(where: {
      role($0.element) == "AXButton"
        && (label($0.element).hasPrefix("Play") || label($0.element).hasPrefix("Pause"))
    }), "Unsupported playback button in file details source or viewer")
  let playback = try transcriptPlayback(media)
  try require(
    downloadPlaybackIdle(playback, required: required),
    "File details source or viewer playback is not known idle")
  return playback
}
struct FileDetailsOpenerCandidate {
  let token: String
  let target: FileDetailsOpenerTarget
  let container: AXUIElement
  let media: AXUIElement
  let control: AXUIElement
  let filePage: AXUIElement?
  let signature: Data
  let videoPins: TranscriptVideoPins
  let playback: [[String: Any]]
  var receipt: [String: Any] {
    [
      "token": token, "scope": "file-details-opener", "openerKind": target.openerKind,
      "containerIndex": target.containerIndex,
      "mediaIndex": target.mediaIndex, "controlIndex": target.controlIndex,
      "filePageIndex": target.filePageIndex as Any? ?? NSNull(),
      "filePageURL": target.filePageURL as Any? ?? NSNull(),
      "fileId": target.fileId, "mediaKind": target.mediaKind,
    ]
  }
}
func fileDetailsOpenerCandidates(
  _ observation: [String: Any], _ elements: [Int: AXUIElement], contextId: String?
) throws -> [FileDetailsOpenerCandidate] {
  guard let content = observation["content"] as? [String: Any],
    content["truncated"] as? Bool == false,
    let rows = content["nodes"] as? [[String: Any]]
  else { throw Failure(description: "File details source capture is incomplete") }
  var result: [FileDetailsOpenerCandidate] = []
  for target in fileDetailsOpenerTargets(rows, contextId: contextId) {
    guard let container = elements[target.containerIndex], let media = elements[target.mediaIndex],
      let control = elements[target.controlIndex],
      target.filePageIndex == nil || target.filePageIndex.flatMap({ elements[$0] }) != nil
    else { continue }
    let playback = try fileDetailsPlayback(media, required: target.mediaKind != "file")
    let pins = TranscriptVideoPins()
    try pins.observe(
      transcriptVideoLayouts(transcriptRawSourceRows(rows, target.containerIndex)), elements)
    result.append(
      FileDetailsOpenerCandidate(
        token: UUID().uuidString, target: target,
        container: container, media: media, control: control,
        filePage: target.filePageIndex.flatMap { elements[$0] },
        signature: try transcriptSourceSignature(
          rows, target.containerIndex, selectedMediaIndex: target.mediaIndex),
        videoPins: pins, playback: playback))
  }
  try require(result.count <= 1000, "File details opener inventory exceeds bounds")
  return result
}
func fileDetailsPanels(_ root: AXUIElement) throws -> [AXUIElement] {
  var result: [AXUIElement] = []
  for node in try tree(root)
  where role(node.element) == "AXGroup"
    && classes(node.element).contains("p-view_contents--secondary")
  {
    if try tree(node.element).contains(where: {
      classes($0.element).contains("p-file_details__references_footer")
    }) {
      result.append(node.element)
    }
  }
  return result
}
func requireFileDetailsIsolation(
  _ workspace: Workspace, _ owned: AXUIElement? = nil,
  downloaded: FileDetailsDownloadCandidate? = nil
) throws {
  let panels = try fileDetailsPanels(workspace.root())
  try require(
    ownedSurfaceMatches(panels, owned),
    "An unrelated or ambiguous file details pane is open; no input requested")
  var tooltipProof: (() throws -> Void)?
  if let downloaded {
    try require(
      owned.map { CFEqual($0, downloaded.pane) } == true,
      "Download tooltip does not belong to the retained file details pane")
    tooltipProof = {
      try verifyFileDetailsTooltipOwner(
        downloaded, panes: { try fileDetailsPanels(workspace.root()) },
        source: {
          _ = try verifyFileDetailsSourceContent(
            downloaded.opener, workspace, pane: downloaded.pane)
        },
        capture: {
          try captureFileDetailsPane(
            downloaded.opener, downloaded.pane, workspace,
            expectedDownloadURL: downloaded.target.url)
        },
        focused: { attr($0, kAXFocusedAttribute) as? Bool })
    }
  }
  try requireViewerIsolation(workspace, detailsDownloadTooltip: tooltipProof)
}
func verifyFileDetailsSource(
  _ selected: FileDetailsOpenerCandidate, _ workspace: Workspace, pane: AXUIElement? = nil,
  ownedMenu: FileDetailsOwnedMenu? = nil, downloaded: FileDetailsDownloadCandidate? = nil
) throws -> [String: Any] {
  try require(
    ownedMenu == nil || downloaded == nil, "Download tooltip cannot authorize an opener menu")
  if let ownedMenu {
    try require(
      pane == nil && selected.target.openerKind == "video-menu", "File details menu scope changed")
    try requireFileDetailsMenuIsolation(workspace, ownedMenu)
  } else {
    try requireFileDetailsIsolation(workspace, pane, downloaded: downloaded)
  }
  return try verifyFileDetailsSourceContent(selected, workspace, pane: pane, ownedMenu: ownedMenu)
}
private func verifyFileDetailsSourceContent(
  _ selected: FileDetailsOpenerCandidate, _ workspace: Workspace, pane: AXUIElement? = nil,
  ownedMenu: FileDetailsOwnedMenu? = nil
) throws -> [String: Any] {
  let root = try workspace.root()
  try require(try queryFields(root).isEmpty, "Search picker appeared; file details input withheld")
  let nodes = try tree(root)
  for element in [selected.container, selected.media, selected.control]
    + (selected.filePage.map { [$0] } ?? [])
  {
    try require(
      nodes.contains { CFEqual($0.element, element) }, "Original file details source disappeared")
    if let pane {
      try require(
        !(try tree(pane).contains { CFEqual($0.element, element) }),
        "File details clone cannot replace original source")
    }
  }
  var mediaIndex: Int?
  var controlIndex: Int?
  var filePageIndex: Int?
  var elements: [Int: AXUIElement] = [:]
  let content = try contentSnapshot(
    selected.container,
    onNode: { index, element in
      elements[index] = element
      if CFEqual(element, selected.media) { mediaIndex = index }
      if CFEqual(element, selected.control) { controlIndex = index }
      if let page = selected.filePage, CFEqual(element, page) { filePageIndex = index }
    })
  let rawRows = content["nodes"] as! [[String: Any]]
  try require(
    content["truncated"] as? Bool == false,
    "File details source capture is incomplete; input withheld")
  let rows =
    try ownedMenu == nil
    ? rawRows
    : fileDetailsMenuSourceRows(
      rawRows, mediaIndex: mediaIndex ?? -1, controlIndex: controlIndex ?? -1)
  try require(
    mediaIndex != nil && controlIndex != nil && (selected.filePage == nil || filePageIndex != nil),
    "Retained file details source ancestry changed")
  let targets = fileDetailsOpenerTargets(
    rows, contextId: workspace.context.split(separator: "/").last.map(String.init))
  try require(
    targets.contains {
      $0.openerKind == selected.target.openerKind && $0.containerIndex == 0
        && $0.mediaIndex == mediaIndex && $0.controlIndex == controlIndex
        && $0.filePageIndex == filePageIndex
        && $0.filePageURL == selected.target.filePageURL && $0.fileId == selected.target.fileId
        && $0.mediaKind == selected.target.mediaKind
    }, "File details opener, page or source identity changed")
  if try transcriptSourceSignature(rows, 0, selectedMediaIndex: mediaIndex) != selected.signature {
    throw ViewerVerificationFailure(
      description: "File details message/media identity or order changed",
      diagnostic: fileDetailsFailureDiagnostic(
        content: content, fileId: selected.target.fileId,
        sourceFilePageURL: selected.target.filePageURL,
        contextId: workspace.context.split(separator: "/").last.map(String.init),
        mediaKind: selected.target.mediaKind, phase: "source-verification",
        reason: "source-signature-mismatch",
        capturedAt: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)),
        sourceVerifiedAtCaptureStart: false, sourceSignatureMatched: false))
  }
  try selected.videoPins.observe(transcriptVideoLayouts(rows), elements)
  let playback = try fileDetailsPlayback(
    selected.media, required: selected.target.mediaKind != "file")
  try require(
    NSDictionary(dictionary: ["values": selected.playback]).isEqual(to: ["values": playback]),
    "File details source playback changed")
  return [
    "content": content, "mediaIndex": mediaIndex!, "controlIndex": controlIndex!,
    "filePageIndex": filePageIndex as Any? ?? NSNull(), "playback": playback,
  ]
}
struct FileDetailsDownloadTarget: Equatable {
  let paneIndex: Int
  let cardIndex: Int
  let fileLinkIndex: Int?
  let identityIndex: Int
  let footerIndex: Int
  let controlIndex: Int
  let closeIndex: Int
  let filePageURL: String?
  let url: String
  let routeKind: String
  let playbackRequired: Bool
}
func fileDetailsDownloadTarget(
  _ rows: [[String: Any]], fileId: String, sourceFilePageURL: String?, contextId: String?
) -> FileDetailsDownloadTarget? {
  func has(_ row: [String: Any], _ name: String) -> Bool {
    (row["classes"] as? [String] ?? []).contains(name)
  }
  func children(_ index: Int) -> [[String: Any]] { rows.filter { $0["parent"] as? Int == index } }
  func one(_ rows: [[String: Any]], _ role: String, _ name: String) -> [String: Any]? {
    let matches = rows.filter { $0["role"] as? String == role && has($0, name) }
    return matches.count == 1 ? matches[0] : nil
  }
  guard let pane = one(rows, "AXGroup", "p-view_contents--secondary"), pane["index"] as? Int == 0,
    has(pane, "p-view_contents"),
    let header = one(children(0), "AXToolbar", "p-flexpane_header"),
    let headerIndex = header["index"] as? Int,
    let body = one(children(0), "AXGroup", "p-flexpane__body"),
    let bodyIndex = body["index"] as? Int,
    let footer = one(children(0), "AXGroup", "p-file_details__references_footer"),
    has(footer, "c-file__actions"), let footerIndex = footer["index"] as? Int
  else { return nil }
  let cards = children(bodyIndex).filter { detailsMediaKind($0) != nil }
  let closes = children(headerIndex).filter {
    $0["role"] as? String == "AXButton" && $0["label"] as? String == "Close"
      && has($0, "p-flexpane_header__control")
  }
  guard cards.count == 1, let cardIndex = cards[0]["index"] as? Int, closes.count == 1,
    let closeIndex = closes[0]["index"] as? Int
  else { return nil }
  let cardRows = transcriptRawSourceRows(rows, cardIndex)
  let pages = cardRows.filter {
    $0["role"] as? String == "AXLink"
      && ($0["url"] as? String).flatMap { detailsFilePageID($0, contextId: contextId) } != nil
  }
  guard pages.count <= 1, detailsFileIDs(rows, cardIndex) == Set([fileId]) else { return nil }
  let page = pages.first
  let pageURL = page?["url"] as? String
  let fileLinkIndex = page?["index"] as? Int
  if let pageURL {
    guard detailsFilePageID(pageURL, contextId: contextId) == fileId,
      sourceFilePageURL == nil || pageURL.utf8.elementsEqual(sourceFilePageURL!.utf8)
    else { return nil }
  } else if sourceFilePageURL != nil {
    return nil
  }
  let playerIDs =
    detailsAudioIdentityRows(rows, cardIndex).filter {
      $0["id"] as? String == "transcript-description-" + fileId
    }
    + detailsVideoIdentityRows(rows, cardIndex).filter {
      $0["id"] as? String == "caption-description-" + fileId
    }
  let identityIndex: Int
  if let fileLinkIndex {
    identityIndex = fileLinkIndex
  } else if playerIDs.count == 1, let index = playerIDs[0]["index"] as? Int {
    identityIndex = index
  } else {
    return nil
  }
  let downloads = transcriptRawSourceRows(rows, footerIndex).filter {
    ["AXLink", "AXButton", "AXMenuItem", "AXPopUpButton"].contains($0["role"] as? String ?? "")
      && downloadLabel($0["label"] as? String ?? "")
  }
  guard downloads.count == 1, let download = downloads.first,
    download["parent"] as? Int == footerIndex,
    download["role"] as? String == "AXLink", has(download, "p-file_details__references_actions"),
    let controlIndex = download["index"] as? Int, let url = download["url"] as? String,
    downloadURLAllowed(url), transcriptVideoFileIds([download], controlIndex) == Set([fileId]),
    !cardRows.contains(where: {
      ["AXTextArea", "AXTextField", "AXDialog", "AXSheet", "AXMenu"].contains(
        $0["role"] as? String ?? "")
        || has($0, "c-message_kit__actions") || has($0, "p-media_viewer_modal")
        || (($0["role"] as? String == "AXButton")
          && (($0["label"] as? String ?? "").hasPrefix("Play")
            || ($0["label"] as? String ?? "").hasPrefix("Pause")))
    })
  else { return nil }
  return FileDetailsDownloadTarget(
    paneIndex: 0, cardIndex: cardIndex, fileLinkIndex: fileLinkIndex, identityIndex: identityIndex,
    footerIndex: footerIndex, controlIndex: controlIndex, closeIndex: closeIndex,
    filePageURL: pageURL, url: url, routeKind: downloadRouteKind(url, contextId: contextId),
    playbackRequired: detailsMediaKind(cards[0]) != "file" || detailsAudioRoot(cards[0]))
}
struct FileDetailsDownloadCapture {
  let observation: [String: Any]
  let target: FileDetailsDownloadTarget
  let elements: [Int: AXUIElement]
  let sourcePlayback: [[String: Any]]
  let viewerPlayback: [[String: Any]]
}
struct FileDetailsPaneCapture {
  let content: [String: Any]
  let target: FileDetailsDownloadTarget
  let elements: [Int: AXUIElement]
  let playback: [[String: Any]]
}
private func captureFileDetailsPane(
  _ selected: FileDetailsOpenerCandidate, _ pane: AXUIElement, _ workspace: Workspace,
  expectedDownloadURL: String? = nil
) throws -> FileDetailsPaneCapture {
  var elements: [Int: AXUIElement] = [:]
  let content = try contentSnapshot(pane, onNode: { elements[$0] = $1 })
  guard content["truncated"] as? Bool == false,
    let target = fileDetailsDownloadTarget(
      content["nodes"] as! [[String: Any]], fileId: selected.target.fileId,
      sourceFilePageURL: selected.target.filePageURL,
      contextId: workspace.context.split(separator: "/").last.map(String.init)),
    let card = elements[target.cardIndex]
  else {
    throw ViewerVerificationFailure(
      description: "File details has no unique source-matched Download control",
      diagnostic: fileDetailsFailureDiagnostic(
        content: content, fileId: selected.target.fileId,
        sourceFilePageURL: selected.target.filePageURL,
        expectedDownloadURL: expectedDownloadURL,
        contextId: workspace.context.split(separator: "/").last.map(String.init),
        mediaKind: selected.target.mediaKind, phase: "capture",
        reason: content["truncated"] as? Bool == false
          ? "source-or-layout-unverified" : "incomplete-capture",
        capturedAt: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))))
  }
  let playback: [[String: Any]]
  do { playback = try fileDetailsPlayback(card, required: target.playbackRequired) } catch {
    throw ViewerVerificationFailure(
      description: String(describing: error),
      diagnostic: fileDetailsFailureDiagnostic(
        content: content, fileId: selected.target.fileId,
        sourceFilePageURL: selected.target.filePageURL,
        expectedDownloadURL: expectedDownloadURL,
        contextId: workspace.context.split(separator: "/").last.map(String.init),
        mediaKind: selected.target.mediaKind, phase: "capture", reason: "playback-unverified",
        capturedAt: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))))
  }
  return FileDetailsPaneCapture(
    content: content, target: target, elements: elements, playback: playback)
}
func captureFileDetailsDownload(
  _ selected: FileDetailsOpenerCandidate, _ pane: AXUIElement, _ workspace: Workspace,
  downloaded: FileDetailsDownloadCandidate? = nil, expectedDownloadURL: String? = nil
) throws -> FileDetailsDownloadCapture {
  let before = identity(try workspace.root())
  let source = try verifyFileDetailsSource(selected, workspace, pane: pane, downloaded: downloaded)
  let fresh = try captureFileDetailsPane(
    selected, pane, workspace, expectedDownloadURL: expectedDownloadURL ?? downloaded?.target.url)
  let sourcePlayback = source["playback"] as! [[String: Any]]
  let after = identity(try workspace.root())
  try require(
    before["url"] as? String == after["url"] as? String
      && before["title"] as? String == after["title"] as? String,
    "File details workspace view changed during capture")
  return FileDetailsDownloadCapture(
    observation: [
      "before": before, "after": after, "source": source, "content": fresh.content,
      "detailsPlayback": ["source": sourcePlayback, "viewer": fresh.playback],
    ], target: fresh.target, elements: fresh.elements,
    sourcePlayback: sourcePlayback, viewerPlayback: fresh.playback)
}
struct FileDetailsDownloadCandidate {
  let token: String
  let opener: FileDetailsOpenerCandidate
  let pane: AXUIElement
  let card: AXUIElement
  let identityElement: AXUIElement
  let footer: AXUIElement
  let control: AXUIElement
  let close: AXUIElement
  let target: FileDetailsDownloadTarget
  let viewerPlayback: [[String: Any]]
  var contextId: String? = nil
  var receipt: [String: Any] {
    [
      "token": token, "scope": "file-details", "openerToken": opener.token,
      "openerKind": opener.target.openerKind,
      "paneIndex": target.paneIndex,
      "cardIndex": target.cardIndex, "fileLinkIndex": target.fileLinkIndex as Any? ?? NSNull(),
      "identityIndex": target.identityIndex, "footerIndex": target.footerIndex,
      "controlIndex": target.controlIndex, "filePageURL": target.filePageURL as Any? ?? NSNull(),
      "fileId": opener.target.fileId,
      "mediaKind": opener.target.mediaKind, "url": target.url, "routeKind": target.routeKind,
    ]
  }
  func verify(_ capture: FileDetailsDownloadCapture) throws {
    try verifyFileDetailsCapture(capture, opener: opener, contextId: contextId)
    try verify(target: capture.target, elements: capture.elements, playback: capture.viewerPlayback)
  }
  func verify(
    target fresh: FileDetailsDownloadTarget, elements: [Int: AXUIElement], playback: [[String: Any]]
  ) throws {
    try require(
      fresh == target,
      "File details page, layout or Download target changed")
    for (index, element) in [
      (fresh.paneIndex, pane), (fresh.cardIndex, card), (fresh.identityIndex, identityElement),
      (fresh.footerIndex, footer), (fresh.controlIndex, control), (fresh.closeIndex, close),
    ] {
      try require(
        elements[index].map { CFEqual($0, element) } == true,
        "Retained file details control identity changed")
    }
    try require(
      downloadPlaybackIdle(playback, required: fresh.playbackRequired)
        && NSDictionary(dictionary: ["values": viewerPlayback]).isEqual(to: [
          "values": playback
        ]), "File details viewer playback changed")
  }
}
// Only the post-accepted-Download path supplies this proof. Tooltip recognition
// never supplies a download capability or substitutes for source verification.
func verifyFileDetailsTooltipOwner(
  _ selected: FileDetailsDownloadCandidate, panes: () throws -> [AXUIElement],
  source: () throws -> Void, capture: () throws -> FileDetailsPaneCapture,
  focused: (AXUIElement) -> Bool?
) throws {
  try require(
    ownedSurfaceMatches(try panes(), selected.pane),
    "Download tooltip has no unique retained file details pane")
  try source()
  let fresh = try capture()
  try selected.verify(target: fresh.target, elements: fresh.elements, playback: fresh.playback)
  try require(
    ownedSurfaceMatches(try panes(), selected.pane) && focused(selected.control) == true,
    "Download tooltip lacks its unique source-bound focused control")
}

func closeOwnedFileDetails(
  _ selected: FileDetailsDownloadCandidate, _ workspace: Workspace,
  downloadAccepted: Bool = false, inputDeadline: Date? = nil, beforePress: () throws -> Void
) throws {
  let downloaded = downloadAccepted ? selected : nil
  try selected.verify(
    captureFileDetailsDownload(
      selected.opener, selected.pane, workspace, downloaded: downloaded,
      expectedDownloadURL: selected.target.url))
  let window = try windowId(workspace.window, workspace.pid)
  try require(
    attr(selected.close, kAXEnabledAttribute) as? Bool == true
      && actions(selected.close).contains(kAXPressAction),
    "File details Close is disabled or lacks AXPress")
  try sampleDesktop("before-owned-file-details-close")
  try finalWindowInput(
    window, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try requireFileDetailsIsolation(workspace, selected.pane, downloaded: downloaded) },
    input: {
      try beforePress()
      try press(selected.close, inputDeadline: inputDeadline)
    })
  let deadline = Date().addingTimeInterval(4)
  repeat {
    settle()
    try sampleDesktop("verify-owned-file-details-close")
    try require(
      try windowId(workspace.window, workspace.pid) == window,
      "Window changed while closing file details")
    if try fileDetailsPanels(workspace.root()).isEmpty {
      _ = try verifyFileDetailsSource(selected.opener, workspace)
      return
    }
  } while Date() < deadline
  throw Failure(
    description:
      "File details Close was attempted once but closure was not verified; inspect before retry")
}

func saveMedia(_ requested: String, _ workspace: Workspace) throws -> Int {
  let operationStarted = Date()
  var deadline = operationStarted.addingTimeInterval(90)
  var sourceRequest: MediaSourceRequest?
  var sourceAttempted = false
  var sourceAccepted = false
  var sourceOpened = false
  var sourceNavigation: [String: Any]?
  var selected: DownloadCandidate?
  var viewerOpener: ViewerOpenerCandidate?
  var viewerSelected: ViewerDownloadCandidate?
  var retainedOpeningViewer: AXUIElement?
  var viewerFailure: [String: Any]?
  var viewerCleanup: [String: Any]?
  var detailsOpener: FileDetailsOpenerCandidate?
  var detailsSelected: FileDetailsDownloadCandidate?
  var retainedOpeningDetailsPane: AXUIElement?
  var detailsPlaybackAfter: [String: Any] = [:]
  var detailsMenu: [String: Any]?
  var detailsMenuAttempted = false
  var detailsMenuAccepted = false
  var detailsMenuSelected = false
  var detailsMenuSelectionAccepted = false
  var detailsMenuClosed = false
  var viewerAttempted = false
  var viewerAccepted = false
  var viewerOpened = false
  var viewerClosed = false
  var viewerCloseAttempted = false
  var viewerCloseError: String?
  var viewerSourceCheck: String?
  var attempted = false
  var accepted = false
  var startedAt: Int64?
  var sourceMatched = false
  var viewerMatched = false
  var playbackVerified = false
  var playbackAfter: [[String: Any]] = []
  func viewerAction() -> [String: Any] {
    var value: [String: Any] = [
      "attempted": viewerAttempted, "accepted": viewerAccepted,
      "opened": viewerOpened, "closed": viewerClosed, "closeAttempted": viewerCloseAttempted,
    ]
    if let viewerCloseError { value["closeError"] = viewerCloseError }
    if let viewerSourceCheck { value["sourceCheck"] = viewerSourceCheck }
    return value
  }
  func receipt(_ phase: String) -> [String: Any] {
    var result: [String: Any] = [
      "operation": "save-media", "phase": phase, "requested": requested, "pid": workspace.pid,
      "action": [
        "attempted": attempted, "accepted": accepted, "startedAt": startedAt as Any? ?? NSNull(),
      ],
      "verification": [
        "sourceMatched": sourceMatched, "downloadRequested": accepted,
        "playbackUnchanged": playbackVerified, "viewerMatched": viewerMatched,
      ],
      "playback": ["before": selected?.playback ?? [], "after": playbackAfter],
      "desktop": ["samples": desktopSamples, "scope": "bounded samples, not continuous proof"],
      "recovery": recoverySteps,
    ]
    if let sourceRequest {
      result["sourceRequest"] = sourceRequest.receipt
      result["sourceAction"] = [
        "attempted": sourceAttempted, "accepted": sourceAccepted, "opened": sourceOpened,
      ]
      result["sourceNavigation"] = sourceNavigation ?? [:]
    }
    if let selected { result["selection"] = selected.receipt }
    if let viewerSelected { result["selection"] = viewerSelected.receipt }
    if let detailsSelected { result["selection"] = detailsSelected.receipt }
    if let detailsOpener {
      result["opener"] = detailsOpener.receipt
      result["viewerAction"] = viewerAction()
      result["detailsMenuAction"] = [
        "attempted": detailsMenuAttempted, "accepted": detailsMenuAccepted,
        "detailsAttempted": detailsMenuSelected, "detailsAccepted": detailsMenuSelectionAccepted,
        "closed": detailsMenuClosed,
      ]
      if let detailsMenu { result["detailsMenu"] = detailsMenu }
      result["detailsPlayback"] = [
        "before": [
          "source": detailsOpener.playback, "viewer": detailsSelected?.viewerPlayback ?? [],
        ], "after": detailsPlaybackAfter,
      ]
    }
    if let viewerOpener {
      result["opener"] = viewerOpener.receipt
      result["viewerAction"] = viewerAction()
    }
    if let viewerFailure { result["viewerFailure"] = viewerFailure }
    if let viewerCleanup { result["viewerCleanup"] = viewerCleanup }
    return result
  }
  do {
    try require(
      try fileViewerPanels(workspace.root()).isEmpty,
      "A file viewer is already open; inspect and close it before saving another attachment")
    try require(
      try fileDetailsPanels(workspace.root()).isEmpty,
      "A file details pane is already open; inspect and close it before saving another attachment")
    var first = try mediaObservation(workspace)
    var elements: [Int: AXUIElement] = [:]
    var second = try mediaObservation(workspace, onNode: { elements[$0] = $1 })
    let contextId = workspace.context.split(separator: "/").last.map(String.init)
    var candidates = try downloadCandidates(second, elements, contextId: contextId)
    var openers = try viewerOpenerCandidates(second, elements, contextId: contextId)
    var detailsOpeners = try fileDetailsOpenerCandidates(second, elements, contextId: contextId)
    try emitTranscriptLine([
      "operation": "save-media", "phase": "select", "requested": requested, "pid": workspace.pid,
      "observations": [first, second], "candidates": candidates.map { $0.receipt },
      "viewerCandidates": openers.map { $0.receipt } + detailsOpeners.map { $0.receipt },
    ])
    var input = try downloadInputLine(min(deadline, Date().addingTimeInterval(20))) {
      try sampleDesktop("wait-download-selection")
    }
    if let source = try mediaSourceRequest(input, requested: requested, contextId: contextId) {
      sourceRequest = source
      try requireMediaSourceAbsent([first, second], source, requested: requested)
      guard let running = NSRunningApplication(processIdentifier: workspace.pid),
        !running.isTerminated
      else {
        throw Failure(description: "Slack process disappeared before source reopening")
      }
      let sourceDeadline = Date().addingTimeInterval(30)
      deadline = operationStarted.addingTimeInterval(120)
      sourceNavigation = [
        "route": "conversation", "conversationId": source.message.conversationId,
        "query": NSNull(), "pages": 0, "matchedMessageRef": NSNull(), "complete": false,
      ]
      sourceAttempted = true
      try navigateMediaSourceConversation(source, workspace, running, sourceDeadline)
      sourceAccepted = true
      func recapture() throws -> Bool {
        try requireGroupLookupBudget(sourceDeadline)
        first = try mediaObservation(workspace)
        settle()
        elements = [:]
        second = try mediaObservation(workspace, onNode: { elements[$0] = $1 })
        try requireGroupLookupBudget(sourceDeadline)
        return [first, second].allSatisfy { observation in
          guard let content = observation["content"] as? [String: Any],
            content["truncated"] as? Bool == false, let rows = content["nodes"] as? [[String: Any]]
          else { return false }
          return mediaSourceMessageExposed(rows, source.message)
        }
      }
      var found = try recapture()
      if !found {
        let query = try searchMediaSource(source, workspace, running, sourceDeadline)
        sourceNavigation = [
          "route": "conversation-search", "conversationId": source.message.conversationId,
          "query": query, "pages": 0, "matchedMessageRef": NSNull(), "complete": false,
        ]
        var page = try firstSearchPage(workspace, query, inputDeadline: sourceDeadline)
        for pageNumber in 1...5 {
          sourceNavigation?["pages"] = pageNumber
          found = try recapture()
          if found { break }
          if page.nextPage == nil || pageNumber == 5 { break }
          page = try advanceSearchPage(page, workspace, inputDeadline: sourceDeadline)
        }
      }
      try require(
        found,
        "Exact source message was not found within 5 scoped result pages / 30 seconds. Read the source or adjust search manually, then retry its fresh media reference; no Download action requested"
      )
      sourceOpened = true
      sourceNavigation?["matchedMessageRef"] = source.messageRef
      sourceNavigation?["complete"] = true
      // Discard every pre-navigation token and retained AX element. The wrapper
      // must resolve the remembered reference against these fresh captures.
      candidates = try downloadCandidates(second, elements, contextId: contextId)
      openers = try viewerOpenerCandidates(second, elements, contextId: contextId)
      detailsOpeners = try fileDetailsOpenerCandidates(second, elements, contextId: contextId)
      var sourcePreflight = receipt("source-select")
      sourcePreflight["observations"] = [first, second]
      sourcePreflight["candidates"] = candidates.map { $0.receipt }
      sourcePreflight["viewerCandidates"] =
        openers.map { $0.receipt } + detailsOpeners.map { $0.receipt }
      try emitTranscriptLine(sourcePreflight)
      input = try downloadInputLine(min(deadline, Date().addingTimeInterval(20))) {
        try sampleDesktop("wait-source-download-selection")
      }
      try require(
        try mediaSourceRequest(input, requested: requested, contextId: contextId) == nil,
        "Source reopening can be requested only once; no further navigation performed")
    }
    if let token = try viewerRequest(
      input, Set(openers.map { $0.token } + detailsOpeners.map { $0.token }))
    {
      deadline = operationStarted.addingTimeInterval(sourceRequest == nil ? 120 : 150)
      if let opener = detailsOpeners.first(where: { $0.token == token }) {
        detailsOpener = opener
        _ = try verifyFileDetailsSource(opener, workspace)
        let window = try windowId(workspace.window, workspace.pid)
        try require(Date() < deadline, "File details preparation exceeded its deadline")
        try require(
          attr(opener.control, kAXEnabledAttribute) as? Bool == true
            && actions(opener.control).contains(kAXPressAction),
          "File details opener is disabled or does not expose AXPress")
        if opener.target.openerKind == "video-menu" {
          guard let corner = attr(opener.control, kAXParentAttribute) as! AXUIElement? else {
            throw Failure(description: "Video More actions lost its source corner")
          }
          try sampleDesktop("immediately-before-video-details-menu")
          detailsMenuAccepted = try finalWindowInput(
            window, currentWindow: { try windowId(workspace.window, workspace.pid) },
            noModal: { try requireFileDetailsIsolation(workspace) },
            input: {
              try requireSaveMediaInputBudget(deadline)
              detailsMenuAttempted = true
              return try interactionAXAction(opener.control, kAXPressAction as CFString) == .success
            })
          try require(
            detailsMenuAccepted,
            "Video More actions did not report success; opening is not replayed")
          settle()
          try sampleDesktop("verify-video-details-menu")
          try require(
            try windowId(workspace.window, workspace.pid) == window,
            "Window changed during video menu opening")
          let (owned, beforeMenu) = try captureFileDetailsMenu(opener, corner, workspace)
          settle()
          let (_, afterMenu) = try captureFileDetailsMenu(
            opener, corner, workspace, retained: owned)
          detailsMenu = ["observations": [beforeMenu, afterMenu]]
          try require(
            Date() < deadline && attr(owned.details, kAXEnabledAttribute) as? Bool == true
              && actions(owned.details).contains(kAXPressAction),
            "Video View details is unavailable")
          try sampleDesktop("immediately-before-video-view-details")
          detailsMenuSelectionAccepted = try finalWindowInput(
            window, currentWindow: { try windowId(workspace.window, workspace.pid) },
            noModal: { try requireFileDetailsMenuIsolation(workspace, owned) },
            input: {
              try requireSaveMediaInputBudget(deadline)
              detailsMenuSelected = true
              viewerAttempted = true
              return try interactionAXAction(owned.details, kAXPressAction as CFString) == .success
            })
          viewerAccepted = detailsMenuSelectionAccepted
          try require(
            detailsMenuSelectionAccepted,
            "Video View details did not report success; selection is not replayed")
          settle()
          let nodes = try tree(workspace.window)
          detailsMenuClosed = !nodes.contains {
            CFEqual($0.element, owned.menu) || CFEqual($0.element, owned.popover)
          }
          try require(detailsMenuClosed, "Owned video menu did not close after View details")
        } else {
          try sampleDesktop("immediately-before-file-details-open")
          viewerAccepted = try finalWindowInput(
            window, currentWindow: { try windowId(workspace.window, workspace.pid) },
            noModal: { try requireFileDetailsIsolation(workspace) },
            input: {
              try requireSaveMediaInputBudget(deadline)
              viewerAttempted = true
              return try interactionAXAction(opener.control, kAXPressAction as CFString) == .success
            })
          try require(
            viewerAccepted, "File details opener did not report success; opening is not replayed")
        }
        let openDeadline = min(deadline, Date().addingTimeInterval(8))
        var openedPane: AXUIElement?
        var lastOpeningDetailsDiagnostic: [String: Any]?
        repeat {
          settle()
          try sampleDesktop("verify-file-details-open")
          try require(
            try windowId(workspace.window, workspace.pid) == window,
            "Slack window changed while opening file details")
          let panels = try fileDetailsPanels(workspace.root())
          try require(
            panels.count <= 1, "Opening exposed ambiguous file details panes; no input replayed")
          if let retainedOpeningDetailsPane {
            try require(
              ownedSurfaceMatches(panels, retainedOpeningDetailsPane),
              "File details pane identity changed during opening; no input replayed")
          }
          if let pane = panels.first {
            viewerOpened = true
            _ = try verifyFileDetailsSource(opener, workspace, pane: pane)
            if retainedOpeningDetailsPane == nil { retainedOpeningDetailsPane = pane }
            let content = try contentSnapshot(pane)
            let rows = content["nodes"] as! [[String: Any]]
            let complete = content["truncated"] as? Bool == false
            let bodies = rows.filter {
              $0["parent"] as? Int == 0 && $0["role"] as? String == "AXGroup"
                && ($0["classes"] as? [String] ?? []).contains("p-flexpane__body")
            }
            let cards =
              bodies.count == 1
              ? rows.filter {
                $0["parent"] as? Int == bodies[0]["index"] as? Int && detailsMediaKind($0) != nil
              } : []
            let cardRows = cards.flatMap { card in
              (card["index"] as? Int).map { transcriptRawSourceRows(rows, $0) } ?? []
            }
            let fileMismatch = cards.contains { card in
              guard let index = card["index"] as? Int, let ids = detailsFileIDs(rows, index),
                !ids.isEmpty
              else { return false }
              return ids != Set([opener.target.fileId])
            }
            let pageMismatch = cardRows.contains { row in
              guard row["role"] as? String == "AXLink", let url = row["url"] as? String,
                detailsFilePageID(url, contextId: contextId) != nil,
                let expected = opener.target.filePageURL
              else { return false }
              return !url.utf8.elementsEqual(expected.utf8)
            }
            let footers = rows.filter {
              $0["parent"] as? Int == 0 && $0["role"] as? String == "AXGroup"
                && ($0["classes"] as? [String] ?? []).contains("p-file_details__references_footer")
            }
            let footerRows =
              footers.count == 1
              ? (footers[0]["index"] as? Int).map { transcriptRawSourceRows(rows, $0) } ?? [] : []
            let downloadMismatch = footerRows.contains { row in
              guard
                ["AXLink", "AXButton", "AXMenuItem", "AXPopUpButton"].contains(
                  row["role"] as? String ?? ""), downloadLabel(row["label"] as? String ?? ""),
                let index = row["index"] as? Int, let ids = transcriptVideoFileIds([row], index),
                !ids.isEmpty
              else { return false }
              return ids != Set([opener.target.fileId])
            }
            let reason =
              !complete
              ? "incomplete-capture"
              : fileMismatch || pageMismatch || downloadMismatch
                ? "source-identity-mismatch"
                : cards.count > 1
                  ? "ambiguous-file-cards"
                  : cards.isEmpty ? "missing-file-card" : "unsupported-file-details-layout"
            let diagnostic = fileDetailsFailureDiagnostic(
              content: content, fileId: opener.target.fileId,
              sourceFilePageURL: opener.target.filePageURL, contextId: contextId,
              mediaKind: opener.target.mediaKind, phase: "opening", reason: reason,
              capturedAt: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
            lastOpeningDetailsDiagnostic = diagnostic
            if !complete || fileMismatch || pageMismatch || downloadMismatch || cards.count > 1 {
              throw ViewerVerificationFailure(
                description:
                  "Opened file details pane has incomplete, ambiguous or mismatched source evidence; input withheld",
                diagnostic: diagnostic)
            }
            if fileDetailsDownloadTarget(
              rows, fileId: opener.target.fileId,
              sourceFilePageURL: opener.target.filePageURL, contextId: contextId) != nil
            {
              openedPane = pane
              break
            }
          }
        } while Date() < openDeadline
        guard let pane = openedPane else {
          let message = "File details opened once but no source-matched Download control verified"
          if let lastOpeningDetailsDiagnostic {
            throw ViewerVerificationFailure(
              description: message, diagnostic: lastOpeningDetailsDiagnostic)
          }
          throw Failure(description: message)
        }
        let beforeDetails = try captureFileDetailsDownload(opener, pane, workspace)
        settle()
        let afterDetails = try captureFileDetailsDownload(opener, pane, workspace)
        let candidate = try verifiedFileDetailsCandidate(
          opener: opener, pane: pane, before: beforeDetails, after: afterDetails,
          contextId: contextId)
        detailsSelected = candidate
        detailsPlaybackAfter = [
          "source": afterDetails.sourcePlayback, "viewer": afterDetails.viewerPlayback,
        ]
        sourceMatched = true
        viewerMatched = true
        playbackVerified = true
        var preflight = receipt("viewer-select")
        preflight["observations"] = [beforeDetails.observation, afterDetails.observation]
        preflight["candidates"] = [candidate.receipt]
        try emitTranscriptLine(preflight)
        let finalInput = try downloadInputLine(min(deadline, Date().addingTimeInterval(20))) {
          try sampleDesktop("wait-file-details-download-selection")
        }
        _ = try downloadSelectionToken(finalInput, [candidate.token])
      } else {
        let opener = openers.first { $0.token == token }!
        viewerOpener = opener
        _ = try verifyViewerSource(opener, workspace)
        let window = try windowId(workspace.window, workspace.pid)
        try require(Date() < deadline, "Viewer preparation exceeded its deadline")
        try require(
          attr(opener.control, kAXEnabledAttribute) as? Bool == true
            && actions(opener.control).contains(kAXPressAction),
          "Viewer opener is disabled or does not expose AXPress")
        try sampleDesktop("immediately-before-viewer-open")
        viewerAccepted = try finalWindowInput(
          window, currentWindow: { try windowId(workspace.window, workspace.pid) },
          noModal: { try requireFileDetailsIsolation(workspace) },
          input: {
            try requireSaveMediaInputBudget(deadline)
            viewerAttempted = true
            return try interactionAXAction(opener.control, kAXPressAction as CFString) == .success
          })
        try require(viewerAccepted, "Viewer opener did not report success; opening is not replayed")
        let openDeadline = min(deadline, Date().addingTimeInterval(8))
        var openedViewer: AXUIElement?
        var lastOpeningDiagnostic: [String: Any]?
        repeat {
          settle()
          try sampleDesktop("verify-viewer-open")
          try require(
            try windowId(workspace.window, workspace.pid) == window,
            "Slack window changed while opening viewer")
          let panels = try fileViewerPanels(workspace.root())
          try require(
            panels.count <= 1, "Opening exposed ambiguous file viewers; no input replayed")
          if let retainedOpeningViewer {
            try require(
              ownedSurfaceMatches(panels, retainedOpeningViewer),
              "Viewer identity changed during opening; no input replayed")
          }
          if let panel = panels.first {
            viewerOpened = true
            _ = try verifyViewerSource(opener, workspace, ownedViewer: panel)
            if retainedOpeningViewer == nil { retainedOpeningViewer = panel }
            let content = try contentSnapshot(panel)
            let rows = content["nodes"] as! [[String: Any]]
            let images = rows.filter {
              ($0["classes"] as? [String] ?? []).contains("p-image_viewer__image")
            }
            let exactImages = images.allSatisfy {
              ($0["url"] as? String)?.utf8.elementsEqual(opener.target.sourceURL.utf8) == true
            }
            let complete = content["truncated"] as? Bool == false
            let reason =
              !complete
              ? "incomplete-capture"
              : !exactImages
                ? "image-source-mismatch"
                : images.isEmpty
                  ? "missing-active-image"
                  : images.count > 1 ? "ambiguous-active-images" : "unsupported-viewer-layout"
            let diagnostic = viewerFailureDiagnostic(
              content: content, sourceURL: opener.target.sourceURL, contextId: contextId,
              phase: "opening", reason: reason,
              capturedAt: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
            lastOpeningDiagnostic = diagnostic
            if !complete || !exactImages {
              throw ViewerVerificationFailure(
                description: !complete
                  ? "Opened viewer capture is incomplete; input withheld"
                  : "Opened viewer image does not match the retained source URL",
                diagnostic: diagnostic)
            }
            if viewerDownloadTarget(rows, sourceURL: opener.target.sourceURL) != nil {
              openedViewer = panel
              break
            }
          }
        } while Date() < openDeadline
        guard let viewer = openedViewer else {
          let message =
            "Viewer opening attempted once but no source-matched Download control verified"
          if let lastOpeningDiagnostic {
            throw ViewerVerificationFailure(description: message, diagnostic: lastOpeningDiagnostic)
          }
          throw Failure(description: message)
        }
        let beforeViewer = try captureViewerDownload(opener, viewer, workspace)
        settle()
        let afterViewer = try captureViewerDownload(opener, viewer, workspace)
        let candidate = try verifiedViewerCandidate(
          opener: opener, viewer: viewer, before: beforeViewer, after: afterViewer)
        viewerSelected = candidate
        sourceMatched = true
        viewerMatched = true
        playbackVerified = true
        var preflight = receipt("viewer-select")
        preflight["observations"] = [beforeViewer.observation, afterViewer.observation]
        preflight["candidates"] = [candidate.receipt]
        try emitTranscriptLine(preflight)
        let finalInput = try downloadInputLine(min(deadline, Date().addingTimeInterval(20))) {
          try sampleDesktop("wait-viewer-download-selection")
        }
        _ = try downloadSelectionToken(finalInput, [candidate.token])
      }
    } else {
      let token = try downloadSelectionToken(input, Set(candidates.map { $0.token }))
      selected = candidates.first { $0.token == token }!
    }
    let window = try windowId(workspace.window, workspace.pid)
    let control: AXUIElement
    if let detailsSelected {
      let fresh = try captureFileDetailsDownload(
        detailsSelected.opener, detailsSelected.pane, workspace,
        expectedDownloadURL: detailsSelected.target.url)
      try detailsSelected.verify(fresh)
      detailsPlaybackAfter = ["source": fresh.sourcePlayback, "viewer": fresh.viewerPlayback]
      control = detailsSelected.control
      viewerMatched = true
    } else if let viewerSelected {
      try viewerSelected.verify(
        captureViewerDownload(viewerSelected.opener, viewerSelected.viewer, workspace))
      control = viewerSelected.control
      viewerMatched = true
      playbackAfter = []
    } else if let selected {
      playbackAfter = try verifyDownloadSource(selected, workspace)
      control = selected.control
    } else {
      throw Failure(description: "Download selection is missing")
    }
    sourceMatched = true
    playbackVerified = true
    try require(Date() < deadline, "Download preparation exceeded its deadline; no input requested")
    try require(
      attr(control, kAXEnabledAttribute) as? Bool == true
        && actions(control).contains(kAXPressAction),
      "Download control is disabled or does not expose AXPress")
    try sampleDesktop("immediately-before-download")
    accepted = try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: {
        if let detailsSelected {
          try requireFileDetailsIsolation(workspace, detailsSelected.pane)
        } else if let viewerSelected {
          try requireViewerIsolation(
            workspace, viewerSelected.viewer, sourceURL: viewerSelected.opener.target.sourceURL)
        } else {
          try requireFileDetailsIsolation(workspace)
        }
      },
      input: {
        try requireSaveMediaInputBudget(deadline)
        startedAt = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
        attempted = true
        playbackVerified = false
        viewerMatched = false
        return try interactionAXAction(control, kAXPressAction as CFString) == .success
      })
    try require(
      accepted,
      "Download AXPress did not report success; input may have been delivered and is not replayed")
    func monitor() throws {
      playbackVerified = false
      viewerMatched = false
      try sampleDesktop("monitor-download")
      _ = try workspace.root()
      try require(
        try windowId(workspace.window, workspace.pid) == window,
        "Slack window changed while downloading")
      try requireNoModal(workspace.window)
      if let detailsSelected {
        sourceMatched = false
        let fresh = try captureFileDetailsDownload(
          detailsSelected.opener, detailsSelected.pane, workspace, downloaded: detailsSelected)
        try detailsSelected.verify(fresh)
        detailsPlaybackAfter = ["source": fresh.sourcePlayback, "viewer": fresh.viewerPlayback]
        sourceMatched = true
        viewerMatched = true
      } else if let viewerSelected {
        sourceMatched = false
        try viewerSelected.verify(
          captureViewerDownload(viewerSelected.opener, viewerSelected.viewer, workspace))
        sourceMatched = true
        viewerMatched = true
      } else if let selected {
        playbackAfter = try verifyDownloadPlayback(selected)
      }
      playbackVerified = true
    }
    try monitor()
    try emitTranscriptLine(receipt("started"))
    let finishDeadline = min(deadline, Date().addingTimeInterval(70))
    if nativeWorkspaceSelection != nil {
      let checkpoint = try downloadInputLine(finishDeadline, duringWait: monitor)
      try downloadWorkspaceCheckpointRequest(checkpoint)
      try monitor()
      try emitTranscriptLine(receipt("publish"))
    }
    let finish = try downloadInputLine(finishDeadline, duringWait: monitor)
    try downloadFinishRequest(finish)
    try monitor()
    if let detailsSelected {
      try closeOwnedFileDetails(
        detailsSelected, workspace, downloadAccepted: accepted, inputDeadline: deadline,
        beforePress: { viewerCloseAttempted = true })
      viewerClosed = true
    } else if let viewerSelected {
      viewerSourceCheck = try closeOwnedViewer(
        viewerSelected, workspace, beforePress: { viewerCloseAttempted = true })
      viewerClosed = true
    }
    var result = receipt("result")
    result["status"] = "ok"
    result["finishedAt"] = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
    try emitTranscriptLine(result)
    return 0
  } catch {
    if let failure = error as? ViewerVerificationFailure { viewerFailure = failure.diagnostic }
    if viewerAttempted, let opener = detailsOpener, !viewerClosed {
      let cleanup = cleanupOwnedViewerAfterFailure(
        downloadAttempted: attempted, openerAccepted: viewerAccepted,
        closeAttempted: viewerCloseAttempted, viewerClosed: viewerClosed
      ) { beforePress in
        try requireSaveMediaInputBudget(deadline)
        try sampleDesktop("before-file-details-failure-cleanup")
        try require(
          opener.target.openerKind != "video-menu"
            || (detailsMenuAccepted && detailsMenuSelectionAccepted && detailsMenuClosed),
          "File details menu transition is unverified; cleanup withheld")
        guard let pane = retainedOpeningDetailsPane else {
          throw Failure(
            description: "No retained source-verified file details pane; cleanup withheld")
        }
        try require(
          ownedSurfaceMatches(try fileDetailsPanels(workspace.root()), pane),
          "Owned file details pane is absent, replaced or ambiguous; cleanup withheld")
        let before = try captureFileDetailsDownload(
          opener, pane, workspace, expectedDownloadURL: detailsSelected?.target.url)
        settle()
        try sampleDesktop("verify-file-details-failure-cleanup")
        let after = try captureFileDetailsDownload(
          opener, pane, workspace, expectedDownloadURL: detailsSelected?.target.url)
        let candidate = try verifiedFileDetailsCandidate(
          opener: opener, pane: pane, before: before, after: after,
          contextId: workspace.context.split(separator: "/").last.map(String.init))
        // A later match grants only this Close. It never becomes the save's
        // selected Download capability or replaces the original rejection.
        if let detailsSelected {
          try detailsSelected.verify(before)
          try detailsSelected.verify(after)
        }
        try closeOwnedFileDetails(
          candidate, workspace, inputDeadline: deadline,
          beforePress: {
            try requireSaveMediaInputBudget(deadline)
            try beforePress()
            viewerCloseAttempted = true
          })
        return "unchanged"
      }
      viewerCleanup = cleanup
      viewerClosed = cleanup["closed"] as? Bool == true
      if let check = cleanup["sourceCheck"] as? String { viewerSourceCheck = check }
      if let closeError = cleanup["error"] as? String { viewerCloseError = closeError }
    }
    if viewerAttempted, let opener = viewerOpener, !viewerClosed {
      let cleanup = cleanupOwnedViewerAfterFailure(
        downloadAttempted: attempted, openerAccepted: viewerAccepted,
        closeAttempted: viewerCloseAttempted, viewerClosed: viewerClosed
      ) { beforePress in
        try requireSaveMediaInputBudget(deadline)
        try sampleDesktop("before-viewer-failure-cleanup")
        guard let viewer = retainedOpeningViewer else {
          throw Failure(description: "No retained source-verified viewer; cleanup withheld")
        }
        try require(
          ownedSurfaceMatches(try fileViewerPanels(workspace.root()), viewer),
          "Owned viewer is absent, replaced or ambiguous; cleanup withheld")
        let candidate: ViewerDownloadCandidate
        if let viewerSelected {
          candidate = viewerSelected
        } else {
          let before = try captureViewerDownload(opener, viewer, workspace)
          settle()
          try sampleDesktop("verify-viewer-failure-cleanup")
          let after = try captureViewerDownload(opener, viewer, workspace)
          candidate = try verifiedViewerCandidate(
            opener: opener, viewer: viewer, before: before, after: after)
        }
        return try closeOwnedViewer(
          candidate, workspace,
          beforePress: {
            try requireSaveMediaInputBudget(deadline)
            try beforePress()
            viewerCloseAttempted = true
          })
      }
      viewerCleanup = cleanup
      viewerClosed = cleanup["closed"] as? Bool == true
      if let check = cleanup["sourceCheck"] as? String { viewerSourceCheck = check }
      if let closeError = cleanup["error"] as? String { viewerCloseError = closeError }
    }
    var result = receipt("result")
    result["status"] = "stopped"
    result["error"] = String(describing: error)
    result["downloadMayHaveStarted"] = attempted
    if let isolation = error as? ViewerIsolationFailure {
      result["viewerIsolation"] = isolation.diagnostic
    }
    result["next"] =
      attempted
      ? "A download may have started. Inspect download state before another command; do not replay the Download action."
      : viewerAttempted && !viewerClosed
        ? "Viewer opening may have changed Slack. Inspect the current viewer before another command; no Download action was requested."
        : "Reread the source and follow its fresh media reference; no Download action was requested."
    if let observation = afterErrorObservation() { result["observation"] = observation }
    try emitTranscriptLine(result)
    return 1
  }
}

struct PageRequest {
  let direction: String
  let cursor: String
  let boundary: MessageLink
  init(_ flag: String) throws {
    let parts = flag.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    try require(
      parts.count == 2 && ["--before", "--after"].contains(String(parts[0])),
      "Use --before=REF or --after=REF")
    let cursor = String(parts[1])
    try require(
      cursor.range(of: #"^[CDG][A-Z0-9]+:[0-9]{10}\.[0-9]{6}$"#, options: .regularExpression)
        != nil, "Page cursor must be an observed CONVERSATION:TIMESTAMP reference")
    self.direction = parts[0] == "--before" ? "older" : "newer"
    self.cursor = cursor
    self.boundary = try MessageLink(cursor)
  }
  func includes(_ timestamp: String) -> Bool {
    direction == "older" ? timestamp < boundary.messageTS : timestamp > boundary.messageTS
  }
}
struct PageRow {
  let element: AXUIElement
  let timestamp: String
}
// Continuations stay in the currently verified destination: never navigate back
// to a guessed conversation or reuse whichever list happens to own focus.
func continuationTarget(
  _ root: AXUIElement, _ operation: String, _ query: String, _ page: PageRequest
) throws -> [String: Any] {
  try require(
    try queryFields(root).isEmpty,
    "Search picker is open; read the destination again before continuing")
  if operation == "read-thread" {
    let requested = try MessageLink(query)
    guard let view = try threadView(root), view.matches(requested), view.loaded else {
      throw Failure(
        description: "Thread view changed; read the thread again for fresh page references")
    }
    try require(
      view.header.conversationId == page.boundary.conversationId,
      "Page cursor belongs to another conversation")
    return view.target(requested, root)
  }
  guard let url = attr(root, kAXURLAttribute) as? URL else {
    throw Failure(
      description: "Conversation view changed; read the destination again for fresh page references"
    )
  }
  if operation == "read-dm", let name = try groupDMName(query) {
    guard var target = try currentGroupTarget(root, page.boundary.conversationId),
      target["name"] as? String == name
    else {
      throw Failure(
        description: "Group-name page destination changed; follow a fresh group:ID continuation")
    }
    target["requestedLookup"] = query
    return target
  }
  if operation == "read-dm", let groupID = try groupDMIdentifier(query) {
    try require(
      page.boundary.conversationId == groupID,
      "Group DM page cursor belongs to another conversation")
    guard let target = try currentGroupTarget(root, groupID) else {
      throw Failure(
        description: "Group DM page destination changed; follow a fresh dms/read-dm group reference"
      )
    }
    return target
  }
  guard
    let name = continuationDestinationName(
      label(root), url.lastPathComponent, page.boundary.conversationId, operation, query)
  else {
    throw Failure(
      description: "Page destination changed; use the exact continuation command from a fresh read")
  }
  return [
    "kind": operation == "read-dm" ? "dm" : "channel", "name": name, "requested": query,
    "handle": NSNull(), "url": url.absoluteString,
  ]
}
func pageRows(_ root: AXUIElement, _ target: [String: Any]) throws -> [PageRow] {
  try require(try queryFields(root).isEmpty, "Search picker appeared during pagination")
  try require(
    (attr(root, kAXURLAttribute) as? URL)?.absoluteString == target["url"] as? String,
    "Pagination destination changed")
  let list: AXUIElement
  let isThread = target["kind"] as? String == "thread"
  let conversation: String
  if isThread {
    guard let requested = target["requestedURL"] as? String,
      let view = try threadView(root), view.matches(try MessageLink(requested)),
      view.header.messageTS == target["rootTS"] as? String,
      view.header.host == target["requestedHost"] as? String
    else { throw Failure(description: "Thread changed during pagination") }
    list = view.list
    conversation = view.header.conversationId
  } else {
    guard let name = target["name"] as? String, let url = attr(root, kAXURLAttribute) as? URL
    else { throw Failure(description: "Conversation identity unavailable") }
    conversation = url.lastPathComponent
    try require(
      pageDestinationMatches(label(root), conversation, target),
      "Conversation identity changed during pagination")
    let panes = try tree(root).filter {
      classes($0.element).contains("p-message_pane")
        && ancestor(
          $0.element, matching: { classes($0).contains("p-workspace__primary_view_body") }) != nil
        && ancestor(
          $0.element, matching: { classes($0).contains(where: { $0.hasPrefix("p-thread") }) })
          == nil
    }
    try require(panes.count == 1, "Expected one main message pane for pagination")
    let lists = try tree(panes[0].element).filter {
      role($0.element) == "AXList"
        && conversationListLabelMatches(label($0.element), name, target)
    }
    try require(lists.count == 1, "Expected one matching message list for pagination")
    list = lists[0].element
  }
  var rows: [PageRow] = []
  for element in attr(list, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
    if let kind = target["kind"] as? String, ["dm", "channel"].contains(kind),
      try isConversationForeword(element, kind: kind)
    {
      continue
    }
    if try isGroupConversationForeword(element, target) {
      continue
    }
    let id = string(element, "AXDOMIdentifier")
    let pattern =
      isThread
      ? #"^[CDG][A-Z0-9]+-[0-9]{10}\.[0-9]{6}-thread-list-Thread_[0-9]{10}\.[0-9]{6}$"#
      : #"^message-list_[0-9]{10}\.[0-9]{6}$"#
    guard id.range(of: pattern, options: .regularExpression) != nil else { continue }
    let timestamp = String(id.split(separator: "_").last!)
    let links = try tree(element).filter { classes($0.element).contains("c-timestamp") }
    try require(links.count <= 1, "Ambiguous message timestamp during pagination")
    if let element = links.first?.element, attr(element, kAXURLAttribute) != nil {
      guard let link = messageLink(element), link.conversationId == conversation,
        link.messageTS == timestamp
      else {
        throw Failure(description: "Message permalink does not match pagination identity")
      }
    }
    rows.append(PageRow(element: element, timestamp: timestamp))
  }
  let timestamps = rows.map { $0.timestamp }
  try require(
    !rows.isEmpty && Set(timestamps).count == timestamps.count && timestamps == timestamps.sorted(),
    "Pagination message order is unavailable or ambiguous")
  return rows
}
// The element at a message row's leading or trailing edge that can be scrolled
// into view on its own: the first or last descendant, in reading order, that
// advertises AXScrollToVisible. Nil when the row has no such descendant.
func pageRowEdge(_ row: AXUIElement, leading: Bool) throws -> AXUIElement? {
  // Leaves only: a wrapper spans the whole row and is as "visible" as the row.
  var ordered: [AXUIElement] = []
  var pending = [row]
  var visited = 0
  while let element = pending.popLast() {
    visited += 1
    try require(visited < 2_000, "Message row is too large to scroll within")
    let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    if children.isEmpty && !CFEqual(element, row) { ordered.append(element) }
    pending += children.reversed()
  }
  let candidates = leading ? ordered : ordered.reversed()
  return candidates.prefix(40).first { actions($0).contains("AXScrollToVisible") }
}
// The list item directly before or after a message row in its own list, when
// that item can be scrolled into view. It is only ever scrolled, never pressed.
func pageRowNeighbour(_ row: AXUIElement, leading: Bool) throws -> AXUIElement? {
  guard let raw = attr(row, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
    return nil
  }
  let siblings = attr(raw as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []
  guard let index = siblings.firstIndex(where: { CFEqual($0, row) }) else { return nil }
  let neighbour = leading ? index - 1 : index + 1
  guard siblings.indices.contains(neighbour),
    actions(siblings[neighbour]).contains("AXScrollToVisible")
  else { return nil }
  return siblings[neighbour]
}
// A read without a page cursor starts from the newest messages. Slack keeps a
// conversation where it was last scrolled (a thread-root lookup can leave it
// days back), so scroll the newest exposed row into view until no newer row
// appears. Reaching no newer row is the proof of being at the end; a bound that
// runs out stops the read instead of returning stale messages as current.
func scrollToNewest(_ workspace: Workspace, _ target: [String: Any]) throws {
  let loadDeadline = Date().addingTimeInterval(4)
  var rows: [PageRow] = []
  while true {
    if let found = try? pageRows(workspace.root(), target) {
      rows = found
      break
    }
    // Not loaded yet, or an empty conversation: the capture reports that itself.
    guard Date() < loadDeadline else { return }
    settle()
  }
  let deadline = Date().addingTimeInterval(30)
  var steps = 0
  defer {
    if steps > 0 {
      recoverySteps.append("Scrolled \(steps) time(s) to reach the newest messages")
    }
  }
  // Slack ends a conversation's list with its own bottom spacer once the newest
  // message is loaded; that row is the end marker. Where a client exposes no
  // spacer, two steps that bring neither a newer message nor a different last
  // item mean the same thing.
  var unchanged = 0
  while steps < 40 && Date() < deadline {
    guard let last = rows.last,
      let raw = attr(last.element, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { return }
    let items = attr(raw as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] ?? []
    if items.contains(where: { string($0, "AXDOMIdentifier") == "message-list_bottomSpacer" }) {
      return
    }
    // The list's final item is scrolled into view; it is never pressed.
    guard let tail = items.last, actions(tail).contains("AXScrollToVisible") else { return }
    let window = try windowId(workspace.window, workspace.pid)
    try requireNoModal(workspace.window)
    try sampleDesktop("before-newest-scroll")
    let accepted = try finalWindowInput(
      window, currentWindow: { try windowId(workspace.window, workspace.pid) },
      noModal: { try requireNoModal(workspace.window) },
      verifyControl: {
        // Same conversation and list, checked by pageRows; rows may still be loading.
        _ = try pageRows(workspace.root(), target)
      },
      input: { () throws -> AXError in
        try interactionAXAction(tail, "AXScrollToVisible" as CFString)
      })
    guard accepted == .success else { return }
    steps += 1
    settle()
    try sampleDesktop("verify-newest-scroll")
    let current = try pageRows(workspace.root(), target)
    let moved =
      current.last.map { $0.timestamp > last.timestamp } == true
      || current.last.map { !CFEqual($0.element, last.element) } == true
    unchanged = moved ? 0 : unchanged + 1
    rows = current
    if unchanged >= 2 { return }
  }
  throw Failure(
    description:
      "The newest messages were not reached within the scroll bound; the conversation is scrolled far back. Read forward with the newer-page reference of a paged read, or reopen the conversation in Slack"
  )
}
func paginate(_ workspace: Workspace, _ target: [String: Any], _ page: PageRequest?) throws
  -> [String: Any]
{
  var root = try workspace.root()
  var rows = try pageRows(root, target)
  let before = rows.map { $0.timestamp }
  var attempts = 0
  var status = "initial"
  if let page {
    func eligible(_ timestamp: String) -> Bool {
      page.includes(timestamp)
        && !(target["kind"] as? String == "thread" && timestamp == target["rootTS"] as? String)
    }
    try require(
      before.contains(page.boundary.messageTS),
      "Page cursor is no longer exposed; read this destination again for fresh page references")
    status = "advanced"
    if !before.contains(where: eligible) {
      let selected = page.direction == "older" ? rows.first! : rows.last!
      let window = try windowId(workspace.window, workspace.pid)
      try requireNoModal(workspace.window)
      try sampleDesktop("before-page-scroll")
      let fresh = try pageRows(workspace.root(), target)
      try require(
        fresh.map { $0.timestamp } == before, "Messages changed before pagination; no scroll posted"
      )
      guard let edge = fresh.first(where: { $0.timestamp == selected.timestamp }) else {
        throw Failure(description: "Page edge disappeared")
      }
      try require(
        actions(edge.element).contains("AXScrollToVisible"),
        "Message does not expose background scrolling")
      var stable = 0
      // The row itself first. A row that already fills the viewport counts as
      // visible, so that scroll does nothing; its own leading or trailing
      // element then brings the row's far edge, and the next rows, into view.
      for attempt in 0..<3 {
        let scrolled: AXUIElement
        if attempt == 0 {
          scrolled = edge.element
        } else {
          // An earlier attempt may have shifted which rows are exposed; the
          // selected edge row itself must still be there.
          let current = try pageRows(workspace.root(), target)
          guard let row = current.first(where: { $0.timestamp == selected.timestamp }) else {
            break
          }
          // Then the list item just beyond the row (a day divider, say) when the
          // row's own edge is already in view but nothing further has loaded.
          guard
            let next = try attempt == 1
              ? pageRowEdge(row.element, leading: page.direction == "older")
              : pageRowNeighbour(row.element, leading: page.direction == "older")
          else { continue }
          scrolled = next
        }
        try require(
          try finalWindowInput(
            window, currentWindow: { try windowId(workspace.window, workspace.pid) },
            noModal: { try requireNoModal(workspace.window) },
            input: { try interactionAXAction(scrolled, "AXScrollToVisible" as CFString) })
            == .success,
          "Message did not accept background scrolling")
        attempts += 1
        let deadline = Date().addingTimeInterval(attempt == 0 ? 5 : 3)
        var previous: [String] = []
        stable = 0
        repeat {
          settle()
          try sampleDesktop("verify-page-scroll")
          root = try workspace.root()
          rows = try pageRows(root, target)
          let ids = rows.map { $0.timestamp }
          try require(
            ids.contains(selected.timestamp),
            "Scrolled edge message is no longer exposed; page continuity is unverified")
          stable = ids == previous ? stable + 1 : 0
          previous = ids
          if stable >= 1 && (ids.contains(where: eligible) || ids == before) { break }
        } while Date() < deadline
        if rows.contains(where: { eligible($0.timestamp) }) { break }
      }
      if rows.contains(where: { eligible($0.timestamp) }) {
        try require(
          stable >= 1,
          "New page did not settle before the deadline; read again for fresh page references")
      } else {
        status = "no-progress"
      }
    }
  }
  return [
    "direction": page?.direction as Any? ?? NSNull(), "cursor": page?.cursor as Any? ?? NSNull(),
    "status": status, "beforeTimestamps": before, "afterTimestamps": rows.map { $0.timestamp },
    "scrollAttempts": attempts,
  ]
}

struct SidebarRow {
  let key: String
  let element: AXUIElement
}
struct SidebarDM: Equatable {
  let name: String
  let kind: String
}
func sidebarDMIdentity(
  _ id: String, _ groupClasses: [String], _ hasAvatar: Bool, _ texts: [String]
) -> SidebarDM? {
  guard
    id.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression)
      == id.startIndex..<id.endIndex,
    !texts.isEmpty
  else { return nil }
  let group = groupClasses.contains("p-channel_sidebar__channel--mpim")
  let individual = groupClasses.contains("p-channel_sidebar__channel--im")
  let own = groupClasses.contains("p-channel_sidebar__channel--im-you")
  if group {
    guard !id.hasPrefix("D"), !individual, !own, texts.count >= 3, texts.count % 2 == 1,
      texts.enumerated().allSatisfy({ index, value in
        index % 2 == 1 ? value == ", " : !value.isEmpty && value != ", "
      })
    else { return nil }
    return SidebarDM(name: texts.joined(), kind: "group")
  }
  guard id.hasPrefix("D"), hasAvatar || individual || own, !texts[0].isEmpty,
    texts.dropFirst().allSatisfy({ $0 == "guest" || (own && $0 == "you") })
  else { return nil }
  return SidebarDM(name: texts[0], kind: own ? "self" : "one-to-one")
}
struct ListingPage {
  let rows: [SidebarRow]
  let channelIds: [String]
  let dmIds: [String]
  let dmIdentities: [String: SidebarDM]
  let scope: [String: Any]
  let scopeKey: Data
  let baseScopeKey: Data
  let sections: [String: Data]
  var rowKeys: [String] { rows.map { $0.key } }
  func sameContent(_ other: ListingPage) -> Bool {
    rowKeys == other.rowKeys && channelIds == other.channelIds && dmIds == other.dmIds
      && scopeKey == other.scopeKey
  }
  func receipt(_ previous: ListingPage?, _ status: String, _ operation: String) -> [String: Any] {
    [
      "status": status, "scrollAttempts": previous == nil ? 0 : 1,
      operation == "dms" ? "dmIds" : "channelIds": operation == "dms" ? dmIds : channelIds,
      "beforeRowKeys": previous?.rowKeys ?? rowKeys,
      "afterRowKeys": rowKeys, "edgeKey": previous?.rowKeys.last as Any? ?? NSNull(),
      "scope": scope,
    ]
  }
}
func sidebarPage(_ root: AXUIElement) throws -> ListingPage {
  let nodes = try tree(root)
  try require(try queryFields(root).isEmpty, "Query picker appeared during sidebar paging")
  guard let url = attr(root, kAXURLAttribute) as? URL,
    url.scheme == "https", url.host == "app.slack.com", !label(root).isEmpty
  else { throw Failure(description: "Sidebar workspace identity is unavailable") }
  let sidebars = nodes.filter { classes($0.element).contains("p-channel_sidebar") }
  let wrappers = nodes.filter { classes($0.element).contains("p-client_workspace_wrapper") }
  let outlines = nodes.filter {
    role($0.element) == "AXOutline" && label($0.element) == "Channels and direct messages"
  }
  try require(
    sidebars.count == 1 && wrappers.count == 1 && outlines.count == 1,
    "Sidebar, workspace or channel outline is unavailable or ambiguous")
  let sidebar = sidebars[0].element
  let outline = outlines[0].element
  func parent(_ element: AXUIElement) -> AXUIElement? {
    guard let value = attr(element, kAXParentAttribute),
      CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
  }
  // The outline sits under a scrollbar hider in some client builds and directly
  // under the channel sidebar in others; both must reach the verified sidebar.
  guard let home = parent(sidebar), let holder = parent(outline),
    let outlineSidebar = classes(holder).contains("c-scrollbar__hider") ? parent(holder) : holder,
    classes(home).contains("p-view_contents"),
    classes(home).contains("p-view_contents--sidebar"), label(home) == "Home",
    CFEqual(outlineSidebar, sidebar),
    classes(outline).contains("c-virtual_list__scroll_container"),
    let wrapper = ancestor(home, matching: { classes($0).contains("p-client_workspace_wrapper") }),
    CFEqual(wrapper, wrappers[0].element), !label(wrapper).isEmpty
  else { throw Failure(description: "Channel outline is outside its verified Home sidebar") }
  let filters = try tree(home).filter {
    role($0.element) == "AXTextField" && label($0.element) == "Channel or user name"
      && classes($0.element).contains("c-filter_input__input")
  }
  try require(filters.count == 1, "Sidebar filter is unavailable or ambiguous")
  guard let filterValue = attr(filters[0].element, kAXValueAttribute) as? String else {
    throw Failure(description: "Sidebar filter value is unavailable")
  }
  var scope: [String: Any] = [
    "url": url.absoluteString, "title": label(root), "workspaceName": label(wrapper),
    "filterValue": filterValue,
  ]
  let baseScopeKey = try JSONSerialization.data(withJSONObject: scope, options: [.sortedKeys])
  var rows: [SidebarRow] = []
  var channelIds: [String] = []
  var channelNames: [String: String] = [:]
  var dmIds: [String] = []
  var dmIdentities: [String: SidebarDM] = [:]
  var sections: [String: Data] = [:]
  var sectionRecords: [[String: Any]] = []
  let deadline = Date().addingTimeInterval(8)
  var visited = 0
  func visit(_ element: AXUIElement, _ path: [String], _ depth: Int) throws {
    visited += 1
    try require(
      Date() < deadline && visited < 5000 && depth <= 40,
      "Sidebar capture exceeded traversal bounds")
    var childPath = path
    if role(element) == "AXRow" {
      let id = string(element, "AXDOMIdentifier")
      try require(!id.isEmpty, "Sidebar row identity is unavailable")
      let keyData = try JSONSerialization.data(
        withJSONObject: path + [id], options: [.withoutEscapingSlashes])
      rows.append(SidebarRow(key: String(decoding: keyData, as: UTF8.self), element: element))
      if id.hasPrefix("sectionHeading-") {
        let section: [String: Any] = [
          "id": id, "label": label(element),
          "expanded": (attr(element, kAXExpandedAttribute) as? Bool) as Any? ?? NSNull(),
        ]
        try require(sections[id] == nil, "Sidebar section identity is ambiguous")
        sections[id] = try JSONSerialization.data(withJSONObject: section, options: [.sortedKeys])
        sectionRecords.append(section)
        childPath.append(id)
      } else if id.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression) != nil {
        let content = try tree(element).dropFirst()
        let groups = content.filter { classes($0.element).contains("p-channel_sidebar__channel") }
        if groups.count == 1 {
          let group = groups[0].element
          let isDM =
            classes(group).contains { name in
              [
                "p-channel_sidebar__channel--mpim", "p-channel_sidebar__channel--im",
                "p-channel_sidebar__channel--im-you",
              ].contains(name)
            } || content.contains { classes($0.element).contains("p-channel_sidebar__user_avatar") }
          let names = (attr(group, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
            role($0) == "AXStaticText" && !label($0).isEmpty
          }
          if let dm = sidebarDMIdentity(
            id, classes(group),
            content.contains { classes($0.element).contains("p-channel_sidebar__user_avatar") },
            names.map { label($0) })
          {
            try require(
              dmIdentities[id] == nil || dmIdentities[id] == dm,
              "One sidebar DM ID has conflicting names or kinds")
            if dmIdentities[id] == nil { dmIds.append(id) }
            dmIdentities[id] = dm
          }
          if !id.hasPrefix("D") && !isDM && names.count == 1 {
            let name = label(names[0])
            try require(
              channelNames[id] == nil || channelNames[id] == name,
              "One sidebar channel ID has conflicting names")
            if channelNames[id] == nil { channelIds.append(id) }
            channelNames[id] = name
          }
        }
      }
    }
    for child in attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
      try visit(child, childPath, depth + 1)
    }
  }
  try visit(outline, [], 0)
  try require(
    !rows.isEmpty && Set(rows.map { $0.key }).count == rows.count,
    "Sidebar row identities are empty or ambiguous")
  scope["sections"] = sectionRecords.sorted { ($0["id"] as! String) < ($1["id"] as! String) }
  return ListingPage(
    rows: rows, channelIds: channelIds, dmIds: dmIds, dmIdentities: dmIdentities, scope: scope,
    scopeKey: try JSONSerialization.data(withJSONObject: scope, options: [.sortedKeys]),
    baseScopeKey: baseScopeKey, sections: sections)
}
struct SidebarGroupSelection {
  let page: ListingPage
  let row: AXUIElement
  let control: AXUIElement
  let name: String
}
func sidebarGroupSelection(_ root: AXUIElement, _ identifier: String) throws
  -> SidebarGroupSelection?
{
  let page = try sidebarPage(root)
  let rows = page.rows.filter { string($0.element, "AXDOMIdentifier") == identifier }
  if try groupSidebarAbsent(rows.count, page.dmIdentities[identifier]?.kind) { return nil }
  guard let dm = page.dmIdentities[identifier] else {
    throw Failure(description: "Verified group sidebar identity disappeared; input withheld")
  }
  let groups = (attr(rows[0].element, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
    role($0) == "AXGroup" && classes($0).contains("p-channel_sidebar__channel")
      && classes($0).contains("p-channel_sidebar__channel--mpim")
  }
  try require(groups.count == 1, "Group DM does not expose one direct sidebar control")
  return SidebarGroupSelection(
    page: page, row: rows[0].element, control: groups[0], name: dm.name)
}
func readGroupDM(
  _ identifier: String, _ workspace: Workspace, _ running: NSRunningApplication
) throws -> [String: Any] {
  var root = try workspace.root()
  if let current = try currentGroupTarget(root, identifier) {
    recoverySteps.append("Requested group DM already open; reused verified current view")
    return current
  }
  try ensureSidebar(workspace, running)
  root = try workspace.root()
  if let current = try currentGroupTarget(root, identifier) {
    recoverySteps.append(
      "Requested group DM already open after Home recovery; reused verified current view")
    return current
  }
  guard let selection = try sidebarGroupSelection(root, identifier) else {
    recoverySteps.append("Group DM absent from sidebar; attempting exact-ID Search lookup")
    return try search(identifier, workspace, running, kind: .group)
  }
  func target(_ url: URL) -> [String: Any] {
    groupTarget(identifier, selection.name, url)
  }
  let window = try windowId(workspace.window, running.processIdentifier)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-open-group-dm")
  root = try workspace.root()
  guard let fresh = try sidebarGroupSelection(root, identifier) else {
    throw Failure(description: "Group DM sidebar target disappeared; input withheld")
  }
  try require(
    fresh.page.scopeKey == selection.page.scopeKey && fresh.name == selection.name
      && CFEqual(fresh.row, selection.row) && CFEqual(fresh.control, selection.control),
    "Group DM sidebar target changed; input withheld")
  try require(
    try windowId(workspace.window, running.processIdentifier) == window,
    "Slack window changed; group DM input withheld")
  try requireNoModal(workspace.window)
  // The direct mpim group control navigates on AXPress where Slack advertises it.
  // A row AXPress can be accepted without navigation, so the row itself is only
  // focused for one guarded Return once the control's press is absent or ignored.
  _ = try activate(
    fresh.control, focusTarget: fresh.row, workspace, window: window, what: "Group DM sidebar row"
  ) {
    guard let url = attr(try workspace.root(), kAXURLAttribute) as? URL else { return false }
    return url.lastPathComponent == identifier
  }
  let deadline = Date().addingTimeInterval(8)
  repeat {
    settle()
    try sampleDesktop("verify-group-dm")
    root = try workspace.root()
    if try queryFields(root).isEmpty, let url = attr(root, kAXURLAttribute) as? URL,
      groupDestinationMatches(label(root), url.lastPathComponent, identifier, selection.name)
    {
      return target(url)
    }
  } while Date() < deadline
  throw Failure(
    description:
      "Group DM action attempted once, but its exact destination was not verified; inspect before retrying"
  )
}
// DMs-view listing uses only the observed recent-conversation list. Message
// previews and the adjacent open conversation never supply listing metadata.
struct DMHubLoading: Error, CustomStringConvertible {
  let description = "DMs view is still loading; no verified conversation list is available"
}
func dmHubTab(_ node: Node) -> Bool {
  role(node.element) == "AXRadioButton"
    && string(node.element, "AXDOMIdentifier") == "dms" && label(node.element) == "DMs"
    && classes(node.element).contains("p-tab_rail__button")
}
func dmHubTabID(_ node: Node) -> Bool {
  role(node.element) == "AXRadioButton" && string(node.element, "AXDOMIdentifier") == "dms"
}
func dmHubURL(_ url: URL) -> Bool {
  url.scheme == "https" && url.host == "app.slack.com" && url.user == nil
    && url.password == nil && url.port == nil && url.query == nil && url.fragment == nil
    && url.pathComponents.count == 4 && url.pathComponents[1] == "client"
    && url.pathComponents[2].range(of: #"^[A-Z0-9]+$"#, options: .regularExpression)
      == url.pathComponents[2].startIndex..<url.pathComponents[2].endIndex
    && url.pathComponents[3] == "dms"
    && url.absoluteString == "https://app.slack.com/client/\(url.pathComponents[2])/dms"
}
func dmHubIdentity(
  _ id: String, _ texts: [String], _ imageCount: Int, _ stackCount: Int
) -> SidebarDM? {
  guard
    id.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression)
      == id.startIndex..<id.endIndex, let name = texts.first, !name.isEmpty,
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else { return nil }
  if id.hasPrefix("D") {
    guard imageCount > 0 && stackCount == 0 else { return nil }
    if texts.count == 1 { return SidebarDM(name: name, kind: "one-to-one") }
    guard
      texts.count == 3 && texts[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !texts[1].isEmpty && texts[2] == "(you)"
    else { return nil }
    return SidebarDM(name: name, kind: "self")
  }
  guard stackCount == 1 && imageCount == 0 else { return nil }
  return SidebarDM(name: name, kind: "group")
}
func dmHubFilterTextMatches(_ value: String, _ labels: [String]) -> Bool {
  let query = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return labels.allSatisfy {
    let text = $0.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty || text == query
  }
}
func dmHubFilterLabels(_ field: AXUIElement) throws -> [String] {
  let deadline = Date().addingTimeInterval(8)
  var pending = [Node(element: field, depth: 0)]
  var labels: [String] = []
  while let node = pending.popLast() {
    try require(
      Date() < deadline && labels.count < 5000 && node.depth <= 40,
      "DMs filter traversal exceeded bounds")
    if node.depth > 0 {
      try require(
        role(node.element) == "AXStaticText", "DMs search contains unsupported nested controls")
      labels.append(label(node.element))
    }
    let children = attr(node.element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    pending += children.reversed().map { Node(element: $0, depth: node.depth + 1) }
  }
  return labels
}
struct DMSearchShape {
  var role: String
  var id: String
  var label: String
  var classes: [String]
}
// CSS-module hashes are not identity. The modern destination is a direct,
// blank group under the named DMs search hierarchy, inside the verified view.
func dmModernDestinationShape(_ chain: [DMSearchShape]) -> Bool {
  guard chain.count == 4 else { return false }
  let destination = chain[0]
  let bar = chain[1]
  let header = chain[2]
  let view = chain[3]
  return destination.role == "AXGroup" && destination.id.isEmpty && destination.label.isEmpty
    && bar.role == "AXGroup" && bar.id.isEmpty && bar.label.isEmpty
    && bar.classes.contains("p-dms_page_header_search_bar")
    && header.role == "AXGroup" && header.id.isEmpty && header.label == "Search DMs"
    && header.classes.contains("p-dms_page_header")
    && header.classes.contains("p-dms_page_header__search-bar")
    && view.role == "AXGroup" && view.id.isEmpty
    && ["Direct messages", "Direct Messages"].contains(view.label)
    && view.classes.contains("p-view_contents")
    && view.classes.contains("p-view_contents--sidebar")
}
func dmSearchShape(_ element: AXUIElement) -> DMSearchShape {
  DMSearchShape(
    role: role(element), id: string(element, "AXDOMIdentifier"), label: label(element),
    classes: classes(element))
}
func dmSearchParent(_ element: AXUIElement) -> AXUIElement? {
  guard let raw = attr(element, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
  else { return nil }
  return (raw as! AXUIElement)
}
func dmSearchView(_ nodes: [Node], _ wrapper: AXUIElement) throws -> AXUIElement {
  let views = nodes.filter {
    classes($0.element).contains("p-view_contents")
      && classes($0.element).contains("p-view_contents--sidebar")
      && ["Direct messages", "Direct Messages"].contains(label($0.element))
  }
  if views.isEmpty { throw DMHubLoading() }
  try require(views.count == 1 && role(views[0].element) == "AXGroup", "DMs view is ambiguous")
  let view = views[0].element
  try require(
    ancestor(
      view,
      matching: {
        classes($0).contains("p-client_workspace__tabpanel") && label($0) == "DMs"
      }) != nil, "DMs view is outside its selected tab panel")
  guard
    let viewWrapper = ancestor(
      view, matching: { classes($0).contains("p-client_workspace_wrapper") }),
    CFEqual(viewWrapper, wrapper)
  else {
    throw Failure(description: "DMs view belongs to a different workspace")
  }
  return view
}
func dmSearchDestination(_ nodes: [Node], _ view: AXUIElement, _ field: AXUIElement) throws
  -> AXUIElement
{
  var destinations: [AXUIElement] = []
  let seen = AXIdentitySet()
  func include(_ element: AXUIElement) {
    if seen.insert(element) { destinations.append(element) }
  }
  for node in nodes {
    let names = classes(node.element)
    if names.contains("p-dms_page_header_search_bar__destination__multi_select_input") {
      // Inventory every legacy candidate, including malformed duplicates.
      include(node.element)
    }
    guard names.contains("p-dms_page_header_search_bar"),
      let header = dmSearchParent(node.element), let owner = dmSearchParent(header),
      CFEqual(owner, view)
    else { continue }
    let suffix = [dmSearchShape(node.element), dmSearchShape(header), dmSearchShape(view)]
    for child in attr(node.element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
      guard dmSearchParent(child).map({ CFEqual($0, node.element) }) == true else { continue }
      if dmModernDestinationShape([dmSearchShape(child)] + suffix) { include(child) }
    }
  }
  try require(destinations.count == 1, "DMs search destination is unavailable or ambiguous")
  let destination = destinations[0]
  let children = attr(destination, kAXChildrenAttribute) as? [AXUIElement] ?? []
  try require(
    dmSearchParent(field).map({ CFEqual($0, destination) }) == true
      && children.filter({ CFEqual($0, field) }).count == 1,
    "DMs search field is not a unique direct child of its verified destination")
  return destination
}
func dmHubPage(_ root: AXUIElement) throws -> ListingPage {
  let nodes = try tree(root)
  try require(try queryFields(root).isEmpty, "Query picker appeared during DMs-view collection")
  guard let url = attr(root, kAXURLAttribute) as? URL, dmHubURL(url), !label(root).isEmpty else {
    throw Failure(description: "DMs-view workspace route is unavailable or changed")
  }
  let wrappers = nodes.filter { classes($0.element).contains("p-client_workspace_wrapper") }
  let tabs = nodes.filter(dmHubTabID)
  try require(
    wrappers.count == 1 && !label(wrappers[0].element).isEmpty,
    "DMs workspace wrapper is unavailable or ambiguous")
  let wrapper = wrappers[0].element
  try require(
    tabs.count == 1 && dmHubTab(tabs[0]) && scalarValue(tabs[0].element) == "1"
      && (attr(tabs[0].element, kAXSelectedAttribute) as? Bool) == true,
    "DMs tab is unavailable, inactive or ambiguous")
  guard
    let tabWrapper = ancestor(
      tabs[0].element, matching: { classes($0).contains("p-client_workspace_wrapper") }),
    CFEqual(tabWrapper, wrapper)
  else {
    throw Failure(description: "DMs tab belongs to a different workspace")
  }
  let view = try dmSearchView(nodes, wrapper)
  let viewNodes = try tree(view)
  let recentViews = viewNodes.filter { classes($0.element).contains("p-recent_page") }
  if recentViews.isEmpty { throw DMHubLoading() }
  try require(recentViews.count == 1, "DMs recent-conversations container is ambiguous")
  let recentNodes = try tree(recentViews[0].element)
  let lists = recentNodes.filter {
    role($0.element) == "AXList" && classes($0.element).contains("c-virtual_list__scroll_container")
  }
  if lists.isEmpty { throw DMHubLoading() }
  try require(
    lists.count == 1
      && ["Direct messages", "Recent conversations"].contains(label(lists[0].element)),
    "DMs list is ambiguous or unsupported")
  let list = lists[0].element
  func parent(_ element: AXUIElement) -> AXUIElement? {
    guard let raw = attr(element, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { return nil }
    return (raw as! AXUIElement)
  }
  // The list sits under a scrollbar hider in some client builds and directly
  // under the recent page in others; both must reach the verified view.
  guard let holder = parent(list),
    let recent = classes(holder).contains("c-scrollbar__hider") ? parent(holder) : holder,
    CFEqual(recent, recentViews[0].element),
    let owner = parent(recent), CFEqual(owner, view)
  else {
    throw Failure(description: "DMs list is outside its verified recent-conversation view")
  }
  let filters = viewNodes.filter {
    string($0.element, "AXDOMIdentifier") == "dms_tab_page__destination"
  }
  try require(
    filters.count == 1 && role(filters[0].element) == "AXComboBox"
      && label(filters[0].element) == "Search query",
    "DMs search destination is unavailable or ambiguous")
  let destination = try dmSearchDestination(viewNodes, view, filters[0].element)
  let destinationChildren =
    attr(destination, kAXChildrenAttribute) as? [AXUIElement] ?? []
  try require(
    destinationChildren.count == 1 && CFEqual(destinationChildren[0], filters[0].element),
    "DMs recipient chips are unsupported; filters were not changed")
  let filterText = try dmHubFilterLabels(filters[0].element)
  let unread = viewNodes.filter {
    classes($0.element).contains("p-unreads_toggle")
  }
  try require(
    unread.count == 1 && role(unread[0].element) == "AXCheckBox"
      && label(unread[0].element).hasPrefix("Filter by unread messages; "),
    "DMs filter controls are unavailable or ambiguous")
  guard let filterValue = attr(filters[0].element, kAXValueAttribute) as? String,
    let unreadValue = scalarValue(unread[0].element), ["0", "1"].contains(unreadValue)
  else {
    throw Failure(description: "DMs filter values are unavailable")
  }
  try require(
    dmHubFilterTextMatches(filterValue, filterText),
    "DMs search contains unverified text or recipient chips; filters were not changed")
  var scope: [String: Any] = [
    "source": "dms-view", "url": url.absoluteString, "title": label(root),
    "workspaceName": label(wrapper),
    "viewLabel": label(view), "listLabel": label(list), "filterValue": filterValue,
    "filterText": filterText, "unreadOnly": unreadValue == "1", "tabSelected": true,
  ]
  if let query = managedDMQueryText(filterValue, filterText) { scope["searchQuery"] = query }
  let scopeKey = try JSONSerialization.data(withJSONObject: scope, options: [.sortedKeys])
  for node in recentNodes where classes(node.element).contains("c-virtual_list__item") {
    let id = string(node.element, "AXDOMIdentifier")
    if id.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression) == id
      .startIndex..<id.endIndex
    {
      try require(
        parent(node.element).map { CFEqual($0, list) } == true,
        "DMs conversation row is outside the verified list")
    }
  }
  var rows: [SidebarRow] = []
  var identities: [String: SidebarDM] = [:]
  var dmIds: [String] = []
  for row in attr(list, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
    let id = string(row, "AXDOMIdentifier")
    try require(
      role(row) == "AXGroup" && classes(row).contains("c-virtual_list__item")
        && id.range(of: #"^[CDG][A-Z0-9]+$"#, options: .regularExpression) == id
          .startIndex..<id.endIndex,
      "DMs list contains a malformed conversation row")
    rows.append(SidebarRow(key: id, element: row))
    let containers = attr(row, kAXChildrenAttribute) as? [AXUIElement] ?? []
    guard containers.count == 1, role(containers[0]) == "AXGroup",
      classes(containers[0]).contains("p-activity_ia4_page__item_container")
    else { continue }
    let items = attr(containers[0], kAXChildrenAttribute) as? [AXUIElement] ?? []
    guard items.count == 1, role(items[0]) == "AXGroup",
      classes(items[0]).contains("p-activity_ia4_page__item--dms"),
      classes(items[0]).contains("p-activity_ia4_page__item"),
      classes(items[0]).contains("c-message_kit__message")
    else { continue }
    let children = attr(items[0], kAXChildrenAttribute) as? [AXUIElement] ?? []
    let metas = children.enumerated().filter {
      classes($0.element).contains("p-dms_channel__meta")
    }
    guard metas.count == 1 && role(metas[0].element) == "AXGroup" else { continue }
    let header = Array(children.prefix(metas[0].offset))
    let texts = header.filter { role($0) == "AXStaticText" && !label($0).isEmpty }.map(label)
    let imageCount = header.filter { role($0) == "AXImage" }.count
    let stackCount = header.filter {
      role($0) == "AXGroup" && classes($0).contains("c-base_icon_image_stacked")
    }.count
    guard let dm = dmHubIdentity(id, texts, imageCount, stackCount) else { continue }
    identities[id] = dm
    dmIds.append(id)
  }
  if rows.isEmpty { throw DMHubLoading() }
  try require(
    Set(rows.map { $0.key }).count == rows.count, "DMs list conversation IDs are duplicated")
  try require(!dmIds.isEmpty, "DMs list has no supported conversation identities")
  return ListingPage(
    rows: rows, channelIds: [], dmIds: dmIds, dmIdentities: identities, scope: scope,
    scopeKey: scopeKey, baseScopeKey: scopeKey, sections: [:])
}

func sameDMHubContent(_ left: ListingPage, _ right: ListingPage) -> Bool {
  left.sameContent(right) && left.dmIdentities == right.dmIdentities
}

// DMs autocomplete is distinct from the recent-conversation list. Positional
// option keys are scoped to one verified query; they are never conversation IDs.
// Named group suggestions expose an owned title separately from the participant
// subtitle. Keep their complete five-node proof private: neither the subtitle nor
// the positional option key is a conversation ID, handle or navigation target.
struct DMNamedGroupNode<T: Hashable>: Equatable {
  var role: String
  var subrole: String?
  var id: String?
  var classes: [String]?
  var parent: T?
  var children: [T]?
  var actions: [String]?
  var enabled: Bool?
  var focused: Bool?
  var hasURL: Bool
  var labels: [String?] = []
  var subroleReadStatus: Int32? = nil
  var subroleValueKind: String? = nil
  var childrenReadStatus: Int32? = nil
  var childrenCountStatus: Int32? = nil
  var reportedChildCount: Int? = nil
  var text: String { labels.compactMap { $0 }.first(where: { !$0.isEmpty }) ?? "" }
}
struct DMNamedGroupProof<T: Hashable>: Equatable {
  let name: String
  let subtitle: String
  let identities: [T]
  let nodes: [DMNamedGroupNode<T>]
  // Exact text channels are part of stability even if their first nonempty label
  // did not change. Element identities are compared separately before selection.
  var signature: String {
    let evidence: [String: Any] = [
      "name": name, "subtitle": subtitle,
      "labels": nodes.map { $0.labels.map { $0 as Any? ?? NSNull() } },
    ]
    return (try? JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]))?
      .base64EncodedString() ?? ""
  }
}
// Failure-only metadata from at most five already-read nodes; no text, DOM IDs,
// class names, URLs or opaque AX identities are emitted.
func dmNamedGroupDiagnostic<T: Hashable>(
  _ stage: String, _ nodes: [DMNamedGroupNode<T>], checks: [String: Bool]
) -> [String: Any] {
  func textState(_ value: String?) -> String {
    value.map { $0.isEmpty ? "empty" : "present" } ?? "missing"
  }
  return [
    "stage": ["option", "group-structure", "text-and-leaves"].contains(stage) ? stage : "unknown",
    "checks": checks,
    "nodes": nodes.prefix(5).map { node -> [String: Any] in
      [
        "roleSupported": ["AXStaticText", "AXGroup"].contains(node.role),
        "subroleState": textState(node.subrole), "idState": textState(node.id),
        "subroleReadStatus": node.subroleReadStatus as Any? ?? NSNull(),
        "subroleValueKind": node.subroleValueKind.map {
          ["missing", "string", "other"].contains($0) ? $0 : "unknown"
        } as Any? ?? NSNull(),
        "classesPresent": node.classes != nil,
        "classCount": node.classes?.count as Any? ?? NSNull(),
        "parentPresent": node.parent != nil,
        "childrenCount": node.children?.count as Any? ?? NSNull(),
        "childrenReadStatus": node.childrenReadStatus as Any? ?? NSNull(),
        "childrenCountStatus": node.childrenCountStatus as Any? ?? NSNull(),
        "reportedChildCount": node.reportedChildCount as Any? ?? NSNull(),
        "actionsPresent": node.actions != nil,
        "actionCount": node.actions?.count as Any? ?? NSNull(),
        "hasPress": node.actions?.contains("AXPress") as Any? ?? NSNull(),
        "enabled": node.enabled as Any? ?? NSNull(), "focused": node.focused as Any? ?? NSNull(),
        "hasURL": node.hasURL,
        "labelStates": node.labels.prefix(3).map(textState),
        "labelChannelsAgree": node.labels.compactMap { $0 }.allSatisfy {
          $0.isEmpty || $0 == node.text
        },
        "textNonblank": !node.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        "textWithinBound": node.text.unicodeScalars.count <= 2000,
        "textHasControls": node.text.unicodeScalars.contains {
          $0.value < 32 || (127...159).contains($0.value)
        },
      ]
    },
  ]
}
func dmNamedGroupProof<T: Hashable>(
  _ option: T, owner: T, marker: T, read: (T) -> DMNamedGroupNode<T>,
  onFailure: (([String: Any]) -> Void)? = nil
) -> DMNamedGroupProof<T>? {
  func safeText(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && text.unicodeScalars.count <= 2000
      && !text.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
  }
  func state(_ node: DMNamedGroupNode<T>, pressable: Bool = false) -> Bool {
    guard node.enabled == true, node.focused == false, !node.hasURL,
      let actions = node.actions, Set(actions).count == actions.count
    else { return false }
    let allowed: Set<String> =
      pressable
      ? ["AXPress", "AXShowMenu", "AXScrollToVisible"] : ["AXShowMenu", "AXScrollToVisible"]
    return Set(actions).isSubset(of: allowed) && (!pressable || actions.contains("AXPress"))
  }
  func consistentText(_ node: DMNamedGroupNode<T>) -> Bool {
    safeText(node.text)
      && node.labels.compactMap { $0 }.allSatisfy { $0.isEmpty || $0 == node.text }
  }
  let candidate = read(option)
  guard option != owner, candidate.parent == owner, candidate.subrole == "",
    let optionID = candidate.id, let optionClasses = candidate.classes,
    dmSearchOptionSupported(
      candidate.role, optionID, optionClasses, directChild: true,
      listClasses: ["c-select_options_list"], allowLegacy: false),
    state(candidate, pressable: true),
    let children = candidate.children, children.count == 3, children[0] == marker,
    Set([owner, option] + children).count == 5
  else {
    onFailure?(
      dmNamedGroupDiagnostic(
        "option", [candidate],
        checks: [
          "distinctOwner": option != owner, "parentMatches": candidate.parent == owner,
          "subroleEmpty": candidate.subrole == "",
          "stateSupported": state(candidate, pressable: true),
          "childCountThree": candidate.children?.count == 3,
          "firstChildMarker": candidate.children?.first == marker,
          "optionShape": dmSearchOptionSupported(
            candidate.role, candidate.id ?? "", candidate.classes ?? [], directChild: true,
            listClasses: ["c-select_options_list"], allowLegacy: false),
        ]))
    return nil
  }
  let counter = read(children[0])
  let wrapper = read(children[1])
  let subtitle = read(children[2])
  guard counter.role == "AXGroup", counter.subrole == "AXEmptyGroup", counter.id == "",
    counter.classes == ["c-small_mpim_entity__mpim_counter"], counter.parent == option,
    counter.children?.isEmpty == true, state(counter),
    wrapper.role == "AXGroup", wrapper.subrole == "AXStrongStyleGroup", wrapper.id == "",
    wrapper.classes == [], wrapper.parent == option, state(wrapper),
    let titleChildren = wrapper.children, titleChildren.count == 1,
    Set([owner, option] + children + titleChildren).count == 6
  else {
    onFailure?(
      dmNamedGroupDiagnostic(
        "group-structure", [candidate, counter, wrapper, subtitle],
        checks: [
          "counterRole": counter.role == "AXGroup",
          "counterSubrole": counter.subrole == "AXEmptyGroup",
          "counterIDEmpty": counter.id == "",
          "counterClasses": counter.classes == ["c-small_mpim_entity__mpim_counter"],
          "counterParent": counter.parent == option,
          "counterChildrenEmpty": counter.children?.isEmpty == true,
          "counterState": state(counter), "wrapperRole": wrapper.role == "AXGroup",
          "wrapperSubrole": wrapper.subrole == "AXStrongStyleGroup",
          "wrapperIDEmpty": wrapper.id == "",
          "wrapperClassesEmpty": wrapper.classes == [], "wrapperParent": wrapper.parent == option,
          "wrapperState": state(wrapper), "wrapperChildCountOne": wrapper.children?.count == 1,
        ]))
    return nil
  }
  let title = read(titleChildren[0])
  let leaves = [title, subtitle]
  guard
    leaves.allSatisfy({
      $0.role == "AXStaticText" && $0.subrole == "" && $0.id == "" && $0.classes == []
        && $0.children?.isEmpty == true && state($0) && consistentText($0)
    }), title.parent == children[1], subtitle.parent == option,
    candidate.text == "\(title.text) \(subtitle.text)",
    candidate.labels.compactMap({ $0 }).allSatisfy({ $0.isEmpty || $0 == candidate.text })
  else {
    onFailure?(
      dmNamedGroupDiagnostic(
        "text-and-leaves", [candidate, counter, wrapper, title, subtitle],
        checks: [
          "leafRoles": leaves.allSatisfy { $0.role == "AXStaticText" },
          "leafSubrolesEmpty": leaves.allSatisfy { $0.subrole == "" },
          "leafIDsEmpty": leaves.allSatisfy { $0.id == "" },
          "leafClassesEmpty": leaves.allSatisfy { $0.classes == [] },
          "leafChildrenEmpty": leaves.allSatisfy { $0.children?.isEmpty == true },
          "leafStates": leaves.allSatisfy { state($0) },
          "leafTextConsistent": leaves.allSatisfy { consistentText($0) },
          "titleParent": title.parent == children[1], "subtitleParent": subtitle.parent == option,
          "aggregateMatches": candidate.text == "\(title.text) \(subtitle.text)",
          "aggregateChannelsAgree": candidate.labels.compactMap { $0 }.allSatisfy {
            $0.isEmpty || $0 == candidate.text
          },
        ]))
    return nil
  }
  return DMNamedGroupProof(
    name: title.text, subtitle: subtitle.text,
    identities: [option, children[0], children[1], titleChildren[0], children[2]],
    nodes: [candidate, counter, wrapper, title, subtitle])
}
// A known absent subrole is different from an AX messaging failure or malformed
// successful read. Only explicit absence can represent the plain text subrole.
func dmNamedGroupSubrole(_ status: AXError, _ raw: CFTypeRef?) -> String? {
  if status == .success { return raw as? String }
  if raw == nil && (status == .noValue || status == .attributeUnsupported) { return "" }
  return nil
}
func readDMNamedGroupNode(_ identity: AXIdentity) -> DMNamedGroupNode<AXIdentity> {
  let values = liveAttrs(
    identity.element,
    [
      kAXRoleAttribute, kAXSubroleAttribute, "AXDOMIdentifier", "AXDOMClassList",
      kAXParentAttribute, kAXChildrenAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
      kAXURLAttribute,
    ])
  let parent = values[4].flatMap {
    CFGetTypeID($0) == AXUIElementGetTypeID() ? AXIdentity(element: $0 as! AXUIElement) : nil
  }
  var rawSubrole: CFTypeRef?
  let subroleStatus = AXUIElementCopyAttributeValue(
    identity.element, kAXSubroleAttribute as CFString, &rawSubrole)
  var rawChildren: CFTypeRef?
  let childrenStatus = AXUIElementCopyAttributeValue(
    identity.element, kAXChildrenAttribute as CFString, &rawChildren)
  let children =
    childrenStatus == .success
    ? (rawChildren as? [AXUIElement])?.map { AXIdentity(element: $0) } : nil
  var childCount: CFIndex = 0
  let countStatus = AXUIElementGetAttributeValueCount(
    identity.element, kAXChildrenAttribute as CFString, &childCount)
  var rawActions: CFArray?
  let actionResult = AXUIElementCopyActionNames(identity.element, &rawActions)
  let nodeRole = values[0] as? String ?? ""
  // Only option/title/subtitle static text is read. Unknown controls and the
  // structural groups never contribute aggregate or editable text.
  let labels: [String?] =
    nodeRole == "AXStaticText"
    ? liveAttrs(identity.element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute])
      .map { $0 as? String } : []
  return DMNamedGroupNode(
    role: nodeRole, subrole: dmNamedGroupSubrole(subroleStatus, rawSubrole),
    id: values[2] as? String,
    classes: values[3] as? [String], parent: parent, children: children,
    actions: actionResult == .success ? rawActions as? [String] : nil,
    enabled: values[6] as? Bool, focused: values[7] as? Bool, hasURL: values[8] != nil,
    labels: labels, subroleReadStatus: subroleStatus.rawValue,
    subroleValueKind: rawSubrole == nil ? "missing" : rawSubrole is String ? "string" : "other",
    childrenReadStatus: childrenStatus.rawValue,
    childrenCountStatus: countStatus.rawValue,
    reportedChildCount: countStatus == .success ? childCount : nil)
}

struct DMSearchMatch {
  let key: String
  let kind: String
  let name: String
  let handle: String?
  let position: Int?
  let setSize: Int?
  let element: AXUIElement
  var namedGroup: DMNamedGroupProof<AXIdentity>? = nil
  var record: [String: Any] {
    [
      "key": key, "kind": kind, "name": name, "handle": handle as Any? ?? NSNull(),
      "position": position as Any? ?? NSNull(), "setSize": setSize as Any? ?? NSNull(),
    ]
  }
}
struct DMSearchPage {
  let scope: [String: Any]
  let matches: [DMSearchMatch]
  let empty: Bool
  var record: [String: Any] {
    ["scope": scope, "matches": matches.map { $0.record }, "empty": empty]
  }
  var signature: Data {
    var evidence = record
    evidence["namedGroupEvidence"] = matches.map { $0.namedGroup?.signature as Any? ?? NSNull() }
    return (try? JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys])) ?? Data()
  }
}
// Virtualized pages may replace AX elements, but overlapping option keys must
// preserve their exact public identity and all private named-group text evidence.
func sameDMSearchMatchIdentity(_ left: DMSearchMatch, _ right: DMSearchMatch) -> Bool {
  left.key == right.key && left.name == right.name && left.kind == right.kind
    && left.handle == right.handle && left.position == right.position
    && left.setSize == right.setSize
    && left.namedGroup?.signature == right.namedGroup?.signature
}
func validDMSearchText(_ text: String, allowEmpty: Bool = false) -> Bool {
  ((allowEmpty && text.isEmpty) || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    && text.unicodeScalars.count <= 200
    && !text.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
}
func dmSearchInteger(_ raw: CFTypeRef?) -> Int? {
  guard let raw, CFGetTypeID(raw) != CFBooleanGetTypeID(), let number = raw as? NSNumber else {
    return nil
  }
  let value = number.doubleValue
  guard value.isFinite, value.rounded(.towardZero) == value, (1...500).contains(value) else {
    return nil
  }
  return Int(value)
}
func dmSearchOptionSupported(
  _ role: String, _ id: String, _ names: [String], directChild: Bool, listClasses: [String],
  allowLegacy: Bool = true
) -> Bool {
  let prefix = "dms_tab_page__destination_option_"
  guard role == "AXStaticText", id.hasPrefix(prefix), directChild else { return false }
  let suffix = String(id.dropFirst(prefix.count))
  guard
    suffix.range(of: #"^(0|[1-9][0-9]*)$"#, options: .regularExpression)
      == suffix.startIndex..<suffix.endIndex
  else { return false }
  if names.contains("p-dms_page_header_search_bar__destination__option") { return allowLegacy }
  guard listClasses.contains("c-select_options_list") else { return false }
  let base = "c-select_options_list__option"
  let active = "c-select_options_list__option--pseudo-active"
  return names == [base] || (names.count == 2 && Set(names) == Set([base, active]))
}
func dmSearchVirtualOptionsOwner(
  _ shape: DMSearchShape, value: String?, hasURL: Bool,
  directListChild: Bool, listChildCount: Int, listClasses: [String]
) -> Bool {
  let expected = [
    "ReactVirtualized__Grid", "ReactVirtualized__List", "c-select_options_list__virtual_list",
  ]
  return directListChild && listChildCount == 1 && listClasses == ["c-select_options_list"]
    && shape.role == "AXGroup" && shape.id.isEmpty && shape.label.isEmpty
    && shape.classes.sorted() == expected.sorted() && value == "" && !hasURL
}
func dmSearchOptionChildrenMatch<T>(
  _ children: [T], _ options: [T], same: (T, T) -> Bool
) -> Bool {
  !options.isEmpty && children.count == options.count
    && zip(children, options).allSatisfy { same($0.0, $0.1) }
}
func dmSearchOptionsOwner(_ list: AXUIElement, _ options: [Node]) throws -> AXUIElement {
  if options.allSatisfy({ dmSearchParent($0.element).map { CFEqual($0, list) } == true }) {
    return list
  }
  let children = accessibilityChildren(list)
  guard let owner = children.first else {
    throw Failure(description: "DMs suggestion owner is unavailable")
  }
  try require(
    dmSearchVirtualOptionsOwner(
      dmSearchShape(owner), value: scalarValue(owner), hasURL: attr(owner, kAXURLAttribute) != nil,
      directListChild: dmSearchParent(owner).map { CFEqual($0, list) } == true,
      listChildCount: children.count, listClasses: classes(list))
      && dmSearchOptionChildrenMatch(
        accessibilityChildren(owner), options.map { $0.element }, same: { CFEqual($0, $1) })
      && options.allSatisfy({
        dmSearchParent($0.element).map { CFEqual($0, owner) } == true
      }),
    "DMs suggestions do not belong to one verified options owner")
  return owner
}
func dmSearchSetComplete(_ keys: [String], _ positions: [Int?], _ sizes: [Int?]) -> Bool {
  guard !keys.isEmpty, keys.count <= 500, positions.count == keys.count, sizes.count == keys.count,
    sizes.allSatisfy({ $0 == keys.count })
  else { return false }
  return keys.enumerated().allSatisfy { index, key in
    key == "option:\(index)" && positions[index] == index + 1
  }
}
func dmQueryContext(_ workspace: Workspace, allowExistingSelection: Bool = false) throws -> (
  AXUIElement, [String: Any]
) {
  let root = try workspace.root()
  let nodes = try tree(root)
  guard let url = attr(root, kAXURLAttribute) as? URL, dmHubURL(url) else {
    throw Failure(description: "DMs search route changed")
  }
  let tabs = nodes.filter(dmHubTabID)
  let wrappers = nodes.filter { classes($0.element).contains("p-client_workspace_wrapper") }
  let fields = nodes.filter { string($0.element, "AXDOMIdentifier") == "dms_tab_page__destination" }
  let unread = nodes.filter { classes($0.element).contains("p-unreads_toggle") }
  try require(
    tabs.count == 1 && dmHubTab(tabs[0]) && scalarValue(tabs[0].element) == "1"
      && (attr(tabs[0].element, kAXSelectedAttribute) as? Bool) == true
      && wrappers.count == 1 && !label(wrappers[0].element).isEmpty
      && fields.count == 1 && role(fields[0].element) == "AXComboBox"
      && label(fields[0].element) == "Search query"
      && unread.count == 1 && role(unread[0].element) == "AXCheckBox"
      && label(unread[0].element).hasPrefix("Filter by unread messages; "),
    "DMs search controls are missing or ambiguous")
  let field = fields[0].element
  let wrapper = wrappers[0].element
  guard
    let tabWrapper = ancestor(
      tabs[0].element, matching: { classes($0).contains("p-client_workspace_wrapper") }),
    CFEqual(tabWrapper, wrapper)
  else { throw Failure(description: "DMs tab belongs to a different workspace") }
  let view = try dmSearchView(nodes, wrapper)
  let destination = try dmSearchDestination(try tree(view), view, field)
  guard
    let fieldWrapper = ancestor(
      field, matching: { classes($0).contains("p-client_workspace_wrapper") }),
    CFEqual(fieldWrapper, wrapper),
    let unreadValue = scalarValue(unread[0].element), ["0", "1"].contains(unreadValue)
  else { throw Failure(description: "DMs search ownership or unread state is unavailable") }
  if !allowExistingSelection {
    let children = attr(destination, kAXChildrenAttribute) as? [AXUIElement] ?? []
    let siblings = children.filter { !CFEqual($0, field) }
    try require(
      children.filter { CFEqual($0, field) }.count == 1 && siblings.count <= 1
        && siblings.allSatisfy {
          role($0) == "AXGroup" && classes($0).contains("c-popover__content")
        },
      "DMs autocomplete contains selected recipients or unsupported controls; search scope changed")
  }
  try require(try queryFields(root).isEmpty, "Global Search picker appeared during DMs search")
  return (
    field,
    [
      "source": "dms-search-autocomplete", "url": url.absoluteString,
      "workspaceName": label(wrappers[0].element), "unreadOnly": unreadValue == "1",
    ]
  )
}
func managedDMQueryText(_ value: String, _ text: [String]) -> String? {
  if text == ["\u{00a0}", "\u{00a0}"] && value == "\u{00a0} \u{00a0}" { return "" }
  if text.count == 3 && text[0] == "\u{00a0}" && text[2] == "\u{00a0}"
    && value == "\u{00a0} \(text[1]) \u{00a0}"
  {
    return text[1]
  }
  return nil
}
func managedDMQuery(_ field: AXUIElement) throws -> String {
  let children = attr(field, kAXChildrenAttribute) as? [AXUIElement] ?? []
  try require(
    children.allSatisfy { role($0) == "AXStaticText" },
    "DMs query contains unsupported recipients or controls")
  guard
    let query = managedDMQueryText(
      string(field, kAXValueAttribute), children.map { string($0, kAXValueAttribute) })
  else {
    throw Failure(description: "DMs managed query has not settled; no search result accepted")
  }
  return query
}
func dmSearchPage(_ workspace: Workspace, _ query: String) throws -> DMSearchPage {
  let (field, context) = try dmQueryContext(workspace)
  try require(try managedDMQuery(field) == query, "DMs search query changed")
  guard let rawParent = attr(field, kAXParentAttribute),
    CFGetTypeID(rawParent) == AXUIElementGetTypeID()
  else {
    throw Failure(description: "DMs search owner unavailable")
  }
  let nodes = try tree(rawParent as! AXUIElement)
  let lists = nodes.filter {
    string($0.element, "AXDOMIdentifier") == "dms_tab_page__destination_listbox"
  }
  if lists.isEmpty { throw DMHubLoading() }
  try require(
    lists.count == 1 && role(lists[0].element) == "AXList"
      && label(lists[0].element) == "Search query",
    "DMs autocomplete list is ambiguous")
  let listNodes = try tree(lists[0].element)
  let options = listNodes.filter {
    string($0.element, "AXDOMIdentifier").hasPrefix("dms_tab_page__destination_option_")
  }
  if options.isEmpty { throw DMHubLoading() }
  try require(options.count <= 500, "DMs search page exceeded the capture bound")
  let optionsOwner = try dmSearchOptionsOwner(lists[0].element, options)
  var matches: [DMSearchMatch] = []
  var empty = false
  for option in options {
    let element = option.element
    let id = string(element, "AXDOMIdentifier")
    let suffix = String(id.dropFirst("dms_tab_page__destination_option_".count))
    try require(
      dmSearchOptionSupported(
        role(element), id, classes(element),
        directChild: dmSearchParent(element).map { CFEqual($0, optionsOwner) } == true,
        listClasses: classes(lists[0].element), allowLegacy: CFEqual(optionsOwner, lists[0].element)
      ),
      "Unsupported DMs search option")
    if classes(element).contains("c-select_options_list__option--disabled") {
      try require(
        options.count == 1 && label(element) == "No items",
        "DMs suggestions are loading or unsupported")
      empty = true
      continue
    }
    let descendants = try tree(element)
    let group = descendants.filter {
      classes($0.element).contains("c-small_mpim_entity__mpim_counter")
    }
    let texts = descendants.dropFirst().filter { role($0.element) == "AXStaticText" }.map {
      label($0.element)
    }
    let name: String
    let handle: String?
    let kind: String
    var namedGroup: DMNamedGroupProof<AXIdentity>?
    if group.count == 1 {
      if texts.count == 1 && texts[0] == label(element) {
        name = texts[0]
      } else {
        guard
          let proof = dmNamedGroupProof(
            AXIdentity(element: element), owner: AXIdentity(element: optionsOwner),
            marker: AXIdentity(element: group[0].element), read: readDMNamedGroupNode,
            onFailure: { if firstDMNamedGroupRejection == nil { firstDMNamedGroupRejection = $0 } })
        else { throw Failure(description: "Group search identity is ambiguous") }
        namedGroup = proof
        name = proof.name
      }
      handle = nil
      kind = "group"
    } else {
      try require(
        group.isEmpty && (texts.count == 1 || texts.count == 2),
        "Person search identity is ambiguous")
      let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
      let nameGroups = children.filter { role($0) == "AXGroup" }
      let handles = children.filter { role($0) == "AXStaticText" }.map(label)
      try require(nameGroups.count == 1 && handles.count <= 1, "Person search header is ambiguous")
      let names = try tree(nameGroups[0]).filter { role($0.element) == "AXStaticText" }.map {
        label($0.element)
      }
      try require(names.count == 1, "Person search name is ambiguous")
      name = names[0]
      handle = handles.first
      kind = "person"
      if let handle {
        try require(
          handle.range(of: #"^[^\s@]+$"#, options: .regularExpression) != nil
            && handle.count <= 200,
          "Person search handle is unsupported")
      }
    }
    try require(
      !name.isEmpty && name.unicodeScalars.count <= 2000
        && !name.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) },
      "Search identity is invalid")
    matches.append(
      DMSearchMatch(
        key: "option:\(suffix)", kind: kind, name: name, handle: handle,
        position: dmSearchInteger(attr(element, "AXARIAPosInSet")),
        setSize: dmSearchInteger(attr(element, "AXARIASetSize")), element: element,
        namedGroup: namedGroup))
  }
  try require(
    Set(matches.map { $0.key }).count == matches.count, "DMs search option keys are duplicated")
  var scope = context
  scope["query"] = query
  return DMSearchPage(scope: scope, matches: matches, empty: empty)
}
func stableDMSearchPage(_ workspace: Workspace, _ query: String, minimumWait: TimeInterval = 0)
  throws -> DMSearchPage
{
  let start = Date()
  let deadline = start.addingTimeInterval(6)
  var previous: DMSearchPage?
  repeat {
    settle()
    try sampleDesktop("verify-dms-search")
    do {
      let observed = try dmSearchPage(workspace, query)
      if previous?.signature == observed.signature && Date().timeIntervalSince(start) >= minimumWait
      {
        return observed
      }
      previous = observed
    } catch is DMHubLoading { previous = nil }
  } while Date() < deadline
  throw Failure(description: "DMs search suggestions did not settle; no paste replayed")
}
var clipboardRestoration: String?
func prepareDMSearch(_ workspace: Workspace, _ running: NSRunningApplication, _ query: String)
  throws -> DMSearchPage
{
  try require(
    validDMSearchText(query), "DMs search requires 1–200 characters without control characters")
  // Reopening only the DMs view resets its managed editor. AX selection echoes
  // do not reliably update this editor's internal replacement range.
  try ensureDMHub(workspace, running)
  let (_, originalContext) = try dmQueryContext(workspace, allowExistingSelection: true)
  try ensureSidebar(workspace, running)
  try ensureDMHub(workspace, running)
  let (field, context) = try dmQueryContext(workspace)
  try require(
    NSDictionary(dictionary: context).isEqual(to: originalContext),
    "DMs workspace or unread toggle changed during query reset")
  try require(try managedDMQuery(field).isEmpty, "DMs query did not reset; paste withheld")
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-dms-query-press")
  try press(field)
  settle()
  func preflight() throws {
    let (fresh, freshContext) = try dmQueryContext(workspace)
    let focus = try focusedNodes(workspace.root())
    try require(
      CFEqual(field, fresh) && NSDictionary(dictionary: freshContext).isEqual(to: context)
        && (try managedDMQuery(fresh)).isEmpty && focus.count == 1
        && CFEqual(focus[0].element, fresh), "DMs query changed or lost focus; paste withheld")
    try requireNoModal(workspace.window)
    try require(
      try windowId(workspace.window, workspace.pid) == window,
      "Slack window changed; paste withheld")
    try require(
      CGPreflightPostEventAccess()
        && CGEventSource.flagsState(.combinedSessionState).intersection([
          .maskCommand, .maskControl, .maskAlternate, .maskShift,
        ]).isEmpty && NSEvent.pressedMouseButtons == 0,
      "Input unavailable or physical input held; paste withheld")
    try sampleDesktop("before-dms-query-paste")
  }
  func event(_ type: NSEvent.EventType) -> CGEvent? {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [.shift],
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window, context: nil, characters: "\u{F727}",
      charactersIgnoringModifiers: "\u{F727}", isARepeat: false, keyCode: 114)?.cgEvent
  }
  guard let down = event(.keyDown), let up = event(.keyUp),
    NSEvent(cgEvent: down)?.windowNumber == window
  else {
    throw Failure(description: "Window-targeted paste event unavailable")
  }
  try preflight()
  let result = try withDMQueryClipboard(query) { checkOwnership in
    try preflight()
    try checkOwnership()
    do {
      try requireForegroundInput()
      defer { (event(.keyUp) ?? up).postToPid(workspace.pid) }
      down.postToPid(workspace.pid)
      axPause(until: Date().addingTimeInterval(0.04))
    }
    let page = try stableDMSearchPage(workspace, query, minimumWait: 1.6)
    var expected = context
    expected["query"] = query
    try require(
      NSDictionary(dictionary: page.scope).isEqual(to: expected),
      "DMs search scope changed after paste")
    return page
  }
  try require(
    clipboardRestoration == "restored" || clipboardRestoration == "newer-copy-preserved",
    "Clipboard restoration could not be verified")
  recoverySteps.append("Verified direct DMs autocomplete search without opening a conversation")
  return result
}
func collectDMSearch(
  _ first: DMSearchPage, _ workspace: Workspace, _ query: String, _ requestedPages: Int
) throws -> [String: Any] {
  var frames = [first.record]
  var previous = first
  var attempted = 1
  var stop = first.empty ? "empty-results" : "requested-pages"
  var failure: String?
  if !first.empty {
    while frames.count < requestedPages {
      attempted += 1
      do {
        let fresh = try dmSearchPage(workspace, query)
        try require(fresh.signature == previous.signature, "DMs search changed before paging")
        guard let edge = fresh.matches.last else {
          throw Failure(description: "DMs search edge unavailable")
        }
        _ = try windowId(workspace.window, workspace.pid)
        try requireNoModal(workspace.window)
        try sampleDesktop("before-dms-search-scroll")
        try require(
          actions(edge.element).contains("AXScrollToVisible"),
          "DMs search edge does not support background scrolling")
        try require(
          try interactionAXAction(edge.element, "AXScrollToVisible" as CFString) == .success,
          "DMs search scroll was not accepted")
        let observed = try stableDMSearchPage(workspace, query, minimumWait: 0.8)
        try require(
          NSDictionary(dictionary: observed.scope).isEqual(to: previous.scope),
          "DMs search scope changed while paging")
        let beforeKeys = previous.matches.map { $0.key }
        let afterKeys = observed.matches.map { $0.key }
        let beforeMap = Dictionary(uniqueKeysWithValues: previous.matches.map { ($0.key, $0) })
        for match in observed.matches {
          if let prior = beforeMap[match.key] {
            try require(
              sameDMSearchMatchIdentity(match, prior),
              "DMs search identity changed while paging")
          }
        }
        let progress = try dmHubRowProgress(beforeKeys, afterKeys)
        if progress == "no-progress" {
          stop = "no-progress"
          break
        }
        frames.append(observed.record)
        previous = observed
      } catch {
        failure = String(describing: error)
        stop = "guard-failed"
        break
      }
    }
  }
  var receipt: [String: Any] = [
    "operation": "dms", "status": failure == nil ? "ok" : "partial", "pid": workspace.pid,
    "dmSearch": ["requested": query, "verified": true], "searchPages": frames,
    "batch": [
      "requestedPages": requestedPages, "collectedPages": frames.count, "attemptedPages": attempted,
      "stopReason": stop,
    ],
    "desktopSamples": desktopSamples, "recovery": recoverySteps,
    "clipboard": ["restoration": clipboardRestoration as Any? ?? NSNull()],
  ]
  if let failure { receipt["error"] = failure }
  return receipt
}
// DMs selections can retain /dms, and Home may restore another conversation.
// Bind the exact typed pane to its own message timestamp links before Home.
func selectedDMIdentifier(_ name: String, group: Bool, _ workspace: Workspace) throws -> String {
  var identifier: String?
  let messageDeadline = Date().addingTimeInterval(6)
  repeat {
    let root = try workspace.root()
    try require(
      conversationTitleMatches(label(root), name, .dm),
      "Selected DM changed before identity capture")
    let prefix = "\(name) (\(group ? "group direct message" : "direct message")"
    let lists = try tree(root).filter {
      role($0.element) == "AXList"
        && (label($0.element) == "\(prefix))" || label($0.element).hasPrefix("\(prefix),"))
        && ancestor($0.element, matching: { classes($0).contains("p-message_pane") }) != nil
        && ancestor(
          $0.element, matching: { classes($0).contains(where: { $0.hasPrefix("p-thread") }) })
          == nil
    }
    try require(lists.count <= 1, "Selected DM message pane is ambiguous")
    if let list = lists.first?.element {
      var ids = Set<String>()
      for row in attr(list, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        let rowID = string(row, "AXDOMIdentifier")
        for node in try tree(row) where classes(node.element).contains("c-timestamp") {
          if let link = messageLink(node.element), rowID == "message-list_\(link.messageTS)" {
            try require(
              (group ? ["C", "G"] : ["D"]).contains(String(link.conversationId.prefix(1))),
              "Selected DM exposed an unexpected conversation kind")
            ids.insert(link.conversationId)
          }
        }
      }
      try require(ids.count <= 1, "Selected DM message identities conflict")
      identifier = ids.first
    }
    if identifier != nil { break }
    settle()
    try sampleDesktop("wait-selected-dm-identity")
  } while Date() < messageDeadline
  guard let identifier else {
    throw Failure(
      description: "Selected DM has no exposed message timestamp identity; no guessed ID used")
  }
  return identifier
}

func individualSidebarControl(_ role: String, _ classes: [String]) -> Bool {
  role == "AXGroup" && classes.contains("p-channel_sidebar__channel")
    && classes.contains("p-channel_sidebar__channel--show-avatars")
    && !classes.contains("p-channel_sidebar__channel--mpim")
}
struct IndividualSidebarNode<T: Hashable>: Equatable {
  var role: String
  var id: String?
  var classes: [String]?
  var parent: T?
  var children: [T]?
  var actions: [String]?
  var focused: Bool?
  var enabled: Bool?
  var labels: [String?] = []
  var text: String { labels.compactMap { $0 }.first(where: { !$0.isEmpty }) ?? "" }
}
struct IndividualSidebarSupplement<T: Hashable>: Equatable {
  let control: T
  let identities: [T]
  let nodes: [IndividualSidebarNode<T>]
}
// This route is available only after the selected DM supplied its exact name
// and canonical D-ID through its message permalinks. The secondary label stays
// opaque; it never becomes a name, handle, organization or navigation query.
func individualSidebarSupplement<T: Hashable>(
  _ rows: [T], identifier: String, name: String, existing: SidebarDM?,
  read: (T) -> IndividualSidebarNode<T>
) -> IndividualSidebarSupplement<T>? {
  guard rows.count == 1, existing == nil, !name.isEmpty,
    identifier.range(of: #"\AD[A-Z0-9]+\z"#, options: .regularExpression) != nil
  else { return nil }
  func passive(_ node: IndividualSidebarNode<T>) -> Bool {
    guard node.focused == false, node.enabled == true, let actions = node.actions else {
      return false
    }
    return Set(actions).isSubset(of: ["AXShowMenu", "AXScrollToVisible"])
  }
  let row = read(rows[0])
  guard row.role == "AXRow", row.id == identifier,
    let rowChildren = row.children, rowChildren.count == 1, rowChildren[0] != rows[0]
  else { return nil }
  let control = read(rowChildren[0])
  guard control.parent == rows[0], control.id == "",
    let controlClasses = control.classes,
    individualSidebarControl(control.role, controlClasses),
    !controlClasses.contains("p-channel_sidebar__channel--im-you"),
    control.enabled == true, control.focused == false,
    control.actions?.contains(kAXPressAction) == true,
    Set(control.actions ?? []).isSubset(of: [kAXPressAction, "AXShowMenu", "AXScrollToVisible"]),
    let children = control.children, children.count == 3,
    Set([rows[0], rowChildren[0]] + children).count == 5
  else { return nil }
  let avatar = read(children[0])
  guard avatar.role == "AXGroup", avatar.id == "", avatar.parent == rowChildren[0],
    avatar.classes == ["p-channel_sidebar__user_avatar"], passive(avatar)
  else { return nil }
  let leaves = children.dropFirst().map(read)
  guard
    leaves.allSatisfy({
      $0.role == "AXStaticText" && $0.id == "" && $0.classes == []
        && $0.parent == rowChildren[0] && $0.children?.isEmpty == true && passive($0)
    }), leaves[0].text == name,
    ![name, "guest", "you"].contains(leaves[1].text),
    !leaves[1].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    leaves[1].text.unicodeScalars.count <= 500,
    !leaves[1].text.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
  else { return nil }
  return IndividualSidebarSupplement(
    control: rowChildren[0], identities: [rows[0], rowChildren[0]] + children,
    nodes: [row, control, avatar] + leaves)
}
func readIndividualSidebarNode(_ identity: AXIdentity) -> IndividualSidebarNode<AXIdentity> {
  let values = liveAttrs(
    identity.element,
    [
      kAXRoleAttribute, "AXDOMIdentifier", "AXDOMClassList", kAXParentAttribute,
      kAXChildrenAttribute, kAXFocusedAttribute, kAXEnabledAttribute,
    ])
  let parent = values[3].flatMap {
    CFGetTypeID($0) == AXUIElementGetTypeID() ? AXIdentity(element: $0 as! AXUIElement) : nil
  }
  let children = (values[4] as? [AXUIElement])?.map { AXIdentity(element: $0) }
  var rawActions: CFArray?
  let actionResult = AXUIElementCopyActionNames(identity.element, &rawActions)
  let nodeRole = values[0] as? String ?? ""
  // Never read aggregate labels or editable content, including an existing draft.
  let labels: [String?] =
    nodeRole == "AXStaticText" && children?.isEmpty == true
    ? liveAttrs(identity.element, [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute])
      .map { $0 as? String } : []
  return IndividualSidebarNode(
    role: nodeRole, id: values[1] as? String, classes: values[2] as? [String], parent: parent,
    children: children, actions: actionResult == .success ? rawActions as? [String] : nil,
    focused: values[5] as? Bool, enabled: values[6] as? Bool, labels: labels)
}
func readKnownIndividualDM(
  _ identifier: String, _ name: String, _ handle: String?,
  _ originalQuery: String, _ workspace: Workspace, _ running: NSRunningApplication
) throws -> [String: Any] {
  try require(
    identifier.range(of: #"^D[A-Z0-9]+$"#, options: .regularExpression)
      == identifier.startIndex..<identifier.endIndex, "Individual DM ID is not canonical")
  try ensureSidebar(workspace, running)
  func current() throws -> [String: Any]? {
    let root = try workspace.root()
    guard try queryFields(root).isEmpty, let url = attr(root, kAXURLAttribute) as? URL,
      url.lastPathComponent == identifier, destinationMatches(label(root), identifier, name, .dm)
    else { return nil }
    return [
      "kind": "dm", "name": name, "requested": originalQuery, "handle": NSNull(),
      "url": url.absoluteString,
    ]
  }
  if let target = try current() { return target }
  let page = try sidebarPage(workspace.root())
  let rows = page.rows.filter { string($0.element, "AXDOMIdentifier") == identifier }
  if rows.isEmpty {
    // A freshly observed, different handle can resolve a name missing from the
    // global picker. Never replay the original failed query or accept its ID on trust.
    guard let handle, "@\(handle)" != originalQuery else {
      throw Failure(
        description:
          "Direct DM opened, but no exact sidebar route or different observed handle is available; canonical read withheld"
      )
    }
    var target: [String: Any]
    do { target = try search("@\(handle)", workspace, running, kind: .dm) } catch {
      throw Failure(
        description:
          "Direct DM opened, but observed-handle navigation did not verify; inspect before retrying: \(error)"
      )
    }
    try require(
      (target["url"] as? String).flatMap { URL(string: $0)?.lastPathComponent } == identifier
        && target["name"] as? String == name,
      "Observed-handle navigation reached a different conversation; no messages returned")
    return target
  }
  let supplement = individualSidebarSupplement(
    rows.map { AXIdentity(element: $0.element) }, identifier: identifier, name: name,
    existing: page.dmIdentities[identifier], read: readIndividualSidebarNode)
  try require(
    rows.count == 1
      && ((page.dmIdentities[identifier]?.name == name
        && ["one-to-one", "self"].contains(page.dmIdentities[identifier]?.kind ?? ""))
        || supplement != nil),
    "Exact individual sidebar identity conflicts; selection withheld")
  func control(_ row: AXUIElement) throws -> AXUIElement {
    let controls = (attr(row, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
      individualSidebarControl(role($0), classes($0))
    }
    try require(controls.count == 1, "Individual DM has no supported direct sidebar control")
    return controls[0]
  }
  let candidate = try control(rows[0].element)
  try require(
    supplement == nil || supplement?.control == AXIdentity(element: candidate),
    "Individual sidebar supplementary control changed; selection withheld")
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-open-exact-individual")
  let fresh = try sidebarPage(workspace.root())
  let freshRows = fresh.rows.filter { string($0.element, "AXDOMIdentifier") == identifier }
  try require(
    fresh.scopeKey == page.scopeKey
      && fresh.dmIdentities[identifier] == page.dmIdentities[identifier]
      && freshRows.count == 1 && CFEqual(freshRows[0].element, rows[0].element)
      && CFEqual(try control(freshRows[0].element), candidate)
      && (try windowId(workspace.window, workspace.pid)) == window,
    "Individual sidebar target changed; selection withheld")
  if let supplement {
    try require(
      individualSidebarSupplement(
        freshRows.map { AXIdentity(element: $0.element) }, identifier: identifier, name: name,
        existing: fresh.dmIdentities[identifier], read: readIndividualSidebarNode) == supplement,
      "Individual sidebar supplementary labels or ownership changed; selection withheld")
  }
  try requireNoModal(workspace.window)
  try press(candidate)
  let deadline = Date().addingTimeInterval(8)
  repeat {
    settle()
    try sampleDesktop("verify-exact-individual")
    if let target = try current() { return target }
  } while Date() < deadline
  throw Failure(description: "Individual sidebar pressed once but exact destination did not verify")
}

func readIndividualDM(
  _ query: String, _ workspace: Workspace,
  _ running: NSRunningApplication, allowClipboard: Bool
) throws -> [String: Any] {
  try resolveIndividualDM(
    query, allowClipboard: allowClipboard,
    primaryLookup: { try search(query, workspace, running, kind: .dm) },
    directLookup: { try readIndividualDMFromSearch(query, workspace, running) })
}
func readIndividualDMFromSearch(
  _ query: String, _ workspace: Workspace,
  _ running: NSRunningApplication
) throws -> [String: Any] {
  recoverySteps.append("Normal DM lookup had no exact match; attempting direct DMs search")
  // DMs search handles are exposed without @, unlike the global Search picker.
  let searchQuery = query.hasPrefix("@") ? String(query.dropFirst()) : query
  try require(validDMSearchText(searchQuery), "Direct DM lookup query is unsupported")
  let page = try prepareDMSearch(workspace, running, searchQuery)
  let complete =
    page.empty
    || dmSearchSetComplete(
      page.matches.map { $0.key },
      page.matches.map { $0.position }, page.matches.map { $0.setSize })
  let exact = page.matches.filter { dmPersonMatches($0.kind, $0.name, $0.handle, query) }
  guard complete && exact.count == 1 else {
    let people = page.matches.filter { $0.kind == "person" }
    let candidates: [[String: Any]] = people.prefix(20).map { person in
      let handle = person.handle.map { "@\($0)" }
      let safe = handle != nil && people.filter { $0.handle == person.handle }.count == 1
      return [
        "name": person.name, "handle": handle as Any? ?? NSNull(),
        "navigation": safe
          ? ["command": "read-dm", "args": [handle!, "--allow-clipboard"]] as Any : NSNull(),
      ]
    }
    throw DestinationChoiceFailure(
      query: query, candidates: candidates,
      candidateCount: people.count, ambiguous: exact.count > 1 || people.count > 1,
      exactMatchCount: exact.count, incomplete: !complete)
  }
  let person = exact[0]
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-open-direct-dm")
  let fresh = try dmSearchPage(workspace, searchQuery)
  let selected = fresh.matches.filter {
    $0.key == person.key
      && dmPersonMatches($0.kind, $0.name, $0.handle, query)
  }
  try require(
    fresh.signature == page.signature && selected.count == 1
      && CFEqual(selected[0].element, person.element),
    "Direct DM candidate changed; selection withheld")
  try require(
    try windowId(workspace.window, workspace.pid) == window,
    "Slack window changed; direct DM selection withheld")
  try requireNoModal(workspace.window)
  try press(selected[0].element)
  let deadline = Date().addingTimeInterval(8)
  var opened = false
  repeat {
    settle()
    try sampleDesktop("verify-open-direct-dm")
    let root = try workspace.root()
    let popup = try tree(root).contains {
      string($0.element, "AXDOMIdentifier") == "dms_tab_page__destination_listbox"
    }
    if !popup && conversationTitleMatches(label(root), person.name, .dm) {
      opened = true
      break
    }
  } while Date() < deadline
  try require(opened, "Direct DM was pressed once but its destination did not verify")
  let identifier = try selectedDMIdentifier(person.name, group: false, workspace)
  var target = try readKnownIndividualDM(
    identifier, person.name, person.handle, query, workspace, running)
  target["requested"] = query
  target["handle"] = person.handle.map { "@\($0)" } as Any? ?? NSNull()
  target["lookup"] = [
    "source": "dms-search-autocomplete", "query": query,
    "conversationId": identifier, "exactMatchCount": 1,
  ]
  recoverySteps.append("Verified direct DMs fallback against its canonical conversation ID")
  return target
}

func readGroupDMByName(_ name: String, _ workspace: Workspace, _ running: NSRunningApplication)
  throws -> [String: Any]
{
  let page = try prepareDMSearch(workspace, running, name)
  try require(
    dmSearchSetComplete(
      page.matches.map { $0.key }, page.matches.map { $0.position }, page.matches.map { $0.setSize }
    ),
    "Exact group lookup has unexposed or uncounted suggestions; no conversation selected. Use a known group:ID reference"
  )
  let matches = page.matches.filter { $0.kind == "group" && $0.name == name }
  try require(
    matches.count == 1,
    "Exact group name is missing or ambiguous; no conversation selected. Run dms --search with a more specific name"
  )
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-open-named-group")
  let fresh = try dmSearchPage(workspace, name)
  let selected = fresh.matches.filter {
    $0.key == matches[0].key && $0.kind == "group" && $0.name == name
  }
  try require(
    fresh.signature == page.signature && selected.count == 1
      && CFEqual(selected[0].element, matches[0].element)
      && selected[0].namedGroup == matches[0].namedGroup,
    "Group search candidate changed; selection withheld")
  try require(
    try windowId(workspace.window, workspace.pid) == window,
    "Slack window changed; group selection withheld")
  try requireNoModal(workspace.window)
  try press(selected[0].element)
  let deadline = Date().addingTimeInterval(8)
  var opened = false
  repeat {
    settle()
    try sampleDesktop("verify-open-named-group")
    let root = try workspace.root()
    let popup = try tree(root).contains {
      string($0.element, "AXDOMIdentifier") == "dms_tab_page__destination_listbox"
    }
    if !popup && conversationTitleMatches(label(root), name, .dm) {
      opened = true
      break
    }
  } while Date() < deadline
  try require(opened, "Named group was pressed once but its destination did not verify")
  let identifier = try selectedDMIdentifier(name, group: true, workspace)
  var target = try readGroupDM(identifier, workspace, running)
  try require(target["name"] as? String == name, "Named group changed during exact-ID navigation")
  target["requestedLookup"] = "group-name:\(name)"
  return target
}

func verifyDMHubContinuation(_ previous: ListingPage, _ observed: ListingPage) throws -> String {
  try require(
    previous.scopeKey == observed.scopeKey, "DMs view or filters changed; continuity is unverified")
  for (id, dm) in previous.dmIdentities where observed.rowKeys.contains(id) {
    try require(observed.dmIdentities[id] == dm, "DM identity changed while paging")
  }
  return try dmHubRowProgress(previous.rowKeys, observed.rowKeys)
}
func firstDMHubPage(_ workspace: Workspace) throws -> ListingPage {
  let deadline = Date().addingTimeInterval(5)
  var stable: ListingPage?
  repeat {
    do {
      let observed = try dmHubPage(workspace.root())
      if let stable, sameDMHubContent(stable, observed) { return observed }
      stable = observed
    } catch is DMHubLoading { stable = nil }
    settle()
    try sampleDesktop("wait-dms-view-page")
  } while Date() < deadline
  throw Failure(description: "DMs-view rows did not settle before the capture deadline")
}
func advanceDMHubPage(_ previous: ListingPage, _ workspace: Workspace) throws -> (
  ListingPage, String
) {
  let window = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-dms-view-scroll")
  let fresh = try dmHubPage(workspace.root())
  try require(sameDMHubContent(previous, fresh), "DMs view changed before paging; no scroll posted")
  guard let edge = fresh.rows.last, let previousEdge = previous.rows.last else {
    throw Failure(description: "DMs-view edge is unavailable")
  }
  try require(
    CFEqual(edge.element, previousEdge.element), "DMs-view edge changed; no scroll posted")
  try require(
    actions(edge.element).contains("AXScrollToVisible"),
    "DMs-view edge does not expose background scrolling")
  try require(
    try windowId(workspace.window, workspace.pid) == window,
    "Slack window changed before DMs scrolling")
  try requireNoModal(workspace.window)
  try sampleDesktop("immediately-before-dms-view-scroll")
  try require(
    try interactionAXAction(edge.element, "AXScrollToVisible" as CFString) == .success,
    "DMs-view edge did not accept background scrolling")
  let deadline = Date().addingTimeInterval(5)
  var stable: ListingPage?
  var last: ListingPage?
  repeat {
    settle()
    try sampleDesktop("verify-dms-view-scroll")
    do {
      let observed = try dmHubPage(workspace.root())
      let status = try verifyDMHubContinuation(previous, observed)
      if let stable, sameDMHubContent(stable, observed), status == "advanced" {
        return (observed, status)
      }
      last = stable
      stable = observed
    } catch is DMHubLoading {
      stable = nil
      last = nil
    }
  } while Date() < deadline
  guard let observed = stable, let last, sameDMHubContent(last, observed) else {
    throw Failure(description: "Scrolled DMs-view did not settle; inspect before retrying")
  }
  return (observed, try verifyDMHubContinuation(previous, observed))
}
func ensureDMHub(_ workspace: Workspace, _ running: NSRunningApplication) throws {
  var root = try workspace.root()
  if try !queryFields(root).isEmpty {
    let id = try windowId(workspace.window, running.processIdentifier)
    try backgroundKey(53, "\u{1B}", root, workspace.window, id, running.processIdentifier)
    root = try workspace.root()
    try require(try queryFields(root).isEmpty, "Query overlay remains open; DMs input withheld")
    recoverySteps.append("Closed existing Search picker before listing DMs")
  }
  if let url = attr(root, kAXURLAttribute) as? URL, dmHubURL(url) {
    let tabs = try tree(root).filter(dmHubTabID)
    try require(
      tabs.count == 1 && dmHubTab(tabs[0]) && scalarValue(tabs[0].element) == "1"
        && (attr(tabs[0].element, kAXSelectedAttribute) as? Bool) == true,
      "DMs route does not expose one active DMs tab; input withheld")
    recoverySteps.append("DMs view already open; reused current list position")
    return
  }
  try prepareAccessibility(workspace.app, control: dmHubTab)
  root = try workspace.root()
  let tabs = try tree(root).filter(dmHubTabID)
  try require(tabs.count == 1 && dmHubTab(tabs[0]), "DMs tab is unavailable or ambiguous")
  let window = try windowId(workspace.window, running.processIdentifier)
  try requireNoModal(workspace.window)
  let previousURL = (attr(root, kAXURLAttribute) as? URL)?.absoluteString
  try sampleDesktop("before-open-dms-view")
  let fresh = try workspace.root()
  let freshTabs = try tree(fresh).filter(dmHubTabID)
  try require(
    freshTabs.count == 1 && dmHubTab(freshTabs[0]) && CFEqual(freshTabs[0].element, tabs[0].element)
      && (attr(fresh, kAXURLAttribute) as? URL)?.absoluteString == previousURL,
    "DMs target or starting view changed; input withheld")
  try require(try queryFields(fresh).isEmpty, "Query picker reopened; DMs input withheld")
  try require(
    try windowId(workspace.window, running.processIdentifier) == window,
    "Slack window changed before DMs navigation")
  try requireNoModal(workspace.window)
  try sampleDesktop("immediately-before-open-dms-view")
  _ = try activate(freshTabs[0].element, workspace, window: window, what: "DMs tab") {
    guard let url = attr(try workspace.root(), kAXURLAttribute) as? URL else { return false }
    return dmHubURL(url)
  }
  let deadline = Date().addingTimeInterval(8)
  repeat {
    settle()
    try sampleDesktop("verify-open-dms-view")
    root = try workspace.root()
    if let url = attr(root, kAXURLAttribute) as? URL, dmHubURL(url), try queryFields(root).isEmpty {
      let tabs = try tree(root).filter(dmHubTabID)
      if tabs.count == 1 && dmHubTab(tabs[0]) && scalarValue(tabs[0].element) == "1"
        && (attr(tabs[0].element, kAXSelectedAttribute) as? Bool) == true
      {
        recoverySteps.append("Opened the verified DMs tab without selecting a conversation")
        return
      }
    }
  } while Date() < deadline
  throw Failure(
    description: "DMs tab pressed once, but its route was not verified; inspect before retrying")
}

func dmHubRowProgress(_ before: [String], _ after: [String]) throws -> String {
  let beforeSet = Set(before)
  let afterSet = Set(after)
  try require(
    !before.isEmpty && !after.isEmpty && beforeSet.count == before.count
      && afterSet.count == after.count,
    "DMs-view row identities are empty or duplicated")
  guard let edge = before.last, let edgeIndex = after.firstIndex(of: edge) else {
    throw Failure(description: "Scrolled DMs-view edge disappeared; continuity is unverified")
  }
  try require(
    before.filter { afterSet.contains($0) } == after.filter { beforeSet.contains($0) },
    "DMs-view order changed; downward continuity is unverified")
  try require(
    after.prefix(edgeIndex).allSatisfy { beforeSet.contains($0) },
    "New DMs-view rows appeared before the scrolled edge; downward continuity is ambiguous")
  return after.dropFirst(edgeIndex + 1).contains { !beforeSet.contains($0) }
    ? "advanced" : "no-progress"
}

func verifySidebarContinuation(_ previous: ListingPage, _ observed: ListingPage) throws -> String {
  try require(previous.baseScopeKey == observed.baseScopeKey, "Sidebar workspace or filter changed")
  for (id, state) in previous.sections {
    if let current = observed.sections[id] {
      try require(current == state, "Sidebar section expansion or name changed")
    }
  }
  let before = previous.rowKeys
  let after = observed.rowKeys
  let beforeSet = Set(before)
  let afterSet = Set(after)
  guard let edge = before.last, let edgeIndex = after.firstIndex(of: edge) else {
    throw Failure(description: "Scrolled sidebar edge disappeared; continuity is unverified")
  }
  try require(
    before.filter { afterSet.contains($0) } == after.filter { beforeSet.contains($0) },
    "Sidebar row order changed; downward continuity is unverified")
  try require(
    after.prefix(edgeIndex).allSatisfy { beforeSet.contains($0) },
    "New sidebar rows appeared before the scrolled edge; downward continuity is ambiguous")
  return after.dropFirst(edgeIndex + 1).contains { !beforeSet.contains($0) }
    ? "advanced" : "no-progress"
}
func firstSidebarPage(_ workspace: Workspace) throws -> ListingPage {
  var previous = try sidebarPage(workspace.root())
  let deadline = Date().addingTimeInterval(5)
  repeat {
    settle()
    try sampleDesktop("wait-sidebar-page")
    let observed = try sidebarPage(workspace.root())
    _ = try verifySidebarContinuation(previous, observed)
    if observed.sameContent(previous) { return observed }
    previous = observed
  } while Date() < deadline
  throw Failure(description: "Sidebar rows did not settle before the capture deadline")
}
func advanceSidebarPage(_ previous: ListingPage, _ workspace: Workspace) throws -> (
  ListingPage, String
) {
  _ = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-sidebar-scroll")
  let fresh = try sidebarPage(workspace.root())
  try require(fresh.sameContent(previous), "Sidebar changed before paging; no scroll posted")
  guard let edge = fresh.rows.last else {
    throw Failure(description: "Sidebar edge is unavailable")
  }
  try require(
    actions(edge.element).contains("AXScrollToVisible"),
    "Sidebar edge does not expose background scrolling")
  try require(
    try interactionAXAction(edge.element, "AXScrollToVisible" as CFString) == .success,
    "Sidebar edge did not accept background scrolling")
  let deadline = Date().addingTimeInterval(5)
  var stable: ListingPage?
  var last: ListingPage?
  repeat {
    settle()
    try sampleDesktop("verify-sidebar-scroll")
    let observed = try sidebarPage(workspace.root())
    let status = try verifySidebarContinuation(previous, observed)
    if let stable, observed.sameContent(stable), status == "advanced" { return (observed, status) }
    last = stable
    stable = observed
  } while Date() < deadline
  guard let observed = stable, let last, observed.sameContent(last) else {
    throw Failure(description: "Scrolled sidebar did not settle; inspect before retrying")
  }
  return (observed, try verifySidebarContinuation(previous, observed))
}

// Mirrors the logical ten-record boundary used by the semantic paginator.
// The wrapper independently verifies every frame and this continuation chain.
func batchBoundary(
  _ timestamps: [String], _ page: PageRequest?, _ isThread: Bool, _ rootTS: String?,
  _ replyCount: Int?, _ direction: String
) -> String? {
  let canonical = timestamps.filter { !isThread || $0 != rootTS }
  let eligible = canonical.filter { page?.includes($0) ?? true }
  let forward = page?.direction == "newer" || (page == nil && isThread)
  let selected = Array(forward ? eligible.prefix(10) : eligible.suffix(10))
  let boundary = direction == "older" ? selected.first : selected.last
  let rootPresent = isThread && rootTS.map { timestamps.contains($0) } == true
  let reachedObservedThreadEdge =
    rootPresent
    && (direction == "older"
      ? selected.first == canonical.first
      : replyCount == canonical.count && selected.last == canonical.last)
  return reachedObservedThreadEdge ? nil : boundary
}

func searchEmptyLabelsMatch(_ labels: [String]) -> Bool {
  let guidance = [
    "You may want to try using different keywords, checking for typos, or adjusting filters.",
    "You may want to try using different keywords, checking for typos or adjusting filters.",
  ]
  return labels.contains("Nothing turned up") && guidance.contains(where: labels.contains)
}
struct SearchLoading: Error, CustomStringConvertible {
  let description = "Search results are still loading; no verified result page is available"
}
struct SearchPage {
  let query: String
  let url: String
  let page: Int?
  let pageCount: Int?
  let resultKeys: [String]
  let scope: [[String: Any]]
  let scopeKey: Data
  let emptyResults: Bool
  let nextControl: AXUIElement?
  var previousControl: AXUIElement? = nil
  var nextPage: Int? {
    guard let page, let pageCount, page < pageCount else { return nil }
    return page + 1
  }
  func sameContent(_ other: SearchPage) -> Bool {
    query == other.query && url == other.url && page == other.page && pageCount == other.pageCount
      && resultKeys == other.resultKeys && scopeKey == other.scopeKey
      && emptyResults == other.emptyResults
  }
  func receipt(_ pressAttempts: Int) -> [String: Any] {
    [
      "query": query, "page": page as Any? ?? NSNull(),
      "pageCount": pageCount as Any? ?? NSNull(), "resultKeys": resultKeys,
      "nextPage": nextPage as Any? ?? NSNull(), "scope": scope,
      "pressAttempts": pressAttempts, "emptyResults": emptyResults,
    ]
  }
}
func searchPageNumbers(_ value: String) throws -> (Int, Int) {
  let pattern = #"^Message results, page ([0-9]+) of ([0-9]+)$"#
  guard let expression = try? NSRegularExpression(pattern: pattern),
    let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
    let first = Range(match.range(at: 1), in: value),
    let second = Range(match.range(at: 2), in: value),
    let page = Int(value[first]), let count = Int(value[second]),
    page > 0, count >= page, count <= 9_007_199_254_740_991
  else { throw Failure(description: "Search page numbering is unavailable or invalid") }
  return (page, count)
}
func passiveSearchReset(
  _ control: [String: Any], directFilterChild: Bool, childCount: Int, hasURL: Bool
) -> Bool {
  let base = ["c-button-unstyled", "p-search_filter__reset_button"]
  let names = (control["classes"] as? [String])?.sorted()
  return directFilterChild && childCount == 0 && !hasURL
    && control["role"] as? String == "AXButton" && control["id"] as? String == ""
    && control["label"] as? String == "Reset" && control["value"] as? String == ""
    && control["selected"] as? Bool == false
    && (names == base.sorted() || names == (base + ["c-button--focus-visible"]).sorted())
}
func passiveSearchFeedback(
  _ control: [String: Any], directFilterChild: Bool, childCount: Int, hasURL: Bool
) -> Bool {
  let names = (control["classes"] as? [String])?.sorted()
  return directFilterChild && childCount == 0 && !hasURL
    && control["role"] as? String == "AXButton" && control["id"] as? String == ""
    && control["label"] as? String == "Give feedback" && control["value"] as? String == ""
    && control["selected"] as? Bool == false
    && (names == ["c-link--button"] || names == ["c-link--button", "c-link--focus-visible"])
}
func searchScopeIDsValid(_ ids: [String], passiveKinds: [String?]) -> Bool {
  guard ids.count == passiveKinds.count && !ids.isEmpty else { return false }
  var identities = Set<String>()
  for (id, kind) in zip(ids, passiveKinds) {
    let identity: String
    if id.isEmpty {
      guard let kind, ["reset", "feedback"].contains(kind) else { return false }
      identity = "passive:\(kind)"
    } else {
      identity = "id:\(id)"
    }
    if !identities.insert(identity).inserted { return false }
  }
  return true
}
func searchScopeOwnerMatches(
  _ ownerRole: String, _ ownerClasses: [String], _ ownerLabel: String,
  searchViewCount: Int, ownerIsSearchView: Bool, ownerWithinSearchView: Bool
) -> Bool {
  guard searchViewCount == 1, ownerWithinSearchView else { return false }
  if ownerIsSearchView {
    return ownerRole == "AXGroup" && ownerClasses.contains("p-view_contents")
      && ownerLabel == "Search"
  }
  return ownerClasses.contains("c-scrollbar__hider")
}
func searchPage(_ root: AXUIElement, _ query: String) throws -> SearchPage {
  let nodes = try tree(root)
  try require(try queryFields(root).isEmpty, "Search picker appeared during result paging")
  guard let url = attr(root, kAXURLAttribute) as? URL,
    url.scheme == "https", url.host == "app.slack.com", url.lastPathComponent == "search"
  else { throw Failure(description: "Search view changed during result paging") }
  let queries = nodes.filter {
    role($0.element) == "AXButton" && label($0.element).hasPrefix("Search: ")
  }
  try require(
    queries.count == 1
      && canonicalChannelSearch(label(queries[0].element))
        == "Search: \(canonicalChannelSearch(query))",
    "Search query changed during result paging")
  let filters = nodes.filter { string($0.element, "AXDOMIdentifier") == "filters-container" }
  try require(filters.count == 1, "Search filter scope is unavailable or ambiguous")
  guard let rawScopeParent = attr(filters[0].element, kAXParentAttribute),
    CFGetTypeID(rawScopeParent) == AXUIElementGetTypeID()
  else { throw Failure(description: "Search filter container is unavailable") }
  let scopeParent = rawScopeParent as! AXUIElement
  let searchViews = nodes.filter {
    classes($0.element).contains("p-view_contents") && label($0.element) == "Search"
  }
  func verifiedScopeOwner(_ owner: AXUIElement) -> Bool {
    let view = searchViews.count == 1 ? searchViews[0].element : nil
    let within =
      view.map { searchView in
        ancestor(
          owner,
          matching: {
            CFEqual($0, searchView) && classes($0).contains("p-view_contents")
              && label($0) == "Search"
          }) != nil
      } ?? false
    return searchScopeOwnerMatches(
      role(owner), classes(owner), label(owner), searchViewCount: searchViews.count,
      ownerIsSearchView: view.map { CFEqual(owner, $0) } ?? false,
      ownerWithinSearchView: within)
  }
  try require(
    verifiedScopeOwner(scopeParent),
    "Search filter controls are outside the verified Search view")
  let filterNodes = try tree(filters[0].element)
  let filterBars = filterNodes.filter {
    role($0.element) == "AXToolbar" && label($0.element) == "Filter by"
  }
  try require(filterBars.count == 1, "Search filter toolbar is unavailable or ambiguous")
  let controls = filterNodes.filter { searchScopeRoles.contains(role($0.element)) }
  let sortControls = controls.filter {
    role($0.element) == "AXPopUpButton"
      && string($0.element, "AXDOMIdentifier") == "search-filter-sort-filter"
  }
  let feedbackSortControls = filterNodes.filter {
    string($0.element, "AXDOMIdentifier") == "search-filter-sort-filter"
  }
  var passiveKinds: [String?] = []
  var scope: [[String: Any]] = controls.map { node in
    let element = node.element
    let record: [String: Any] = [
      "role": role(element), "id": string(element, "AXDOMIdentifier"),
      "label": label(element), "value": scalarValue(element) as Any? ?? NSNull(),
      "selected": (attr(element, kAXSelectedAttribute) as? Bool) as Any? ?? NSNull(),
      "classes": classes(element).sorted(),
    ]
    func isDirectChild(_ element: AXUIElement, of parent: AXUIElement) -> Bool {
      guard let raw = attr(element, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
      else { return false }
      return CFEqual(raw, parent)
    }
    let childCount = accessibilityChildren(element).count
    let hasURL = attr(element, kAXURLAttribute) != nil
    let directToolbar = isDirectChild(filterBars[0].element, of: filters[0].element)
    let reset = passiveSearchReset(
      record,
      directFilterChild: isDirectChild(element, of: filterBars[0].element) && directToolbar,
      childCount: childCount, hasURL: hasURL)
    let feedback = passiveSearchFeedback(
      record,
      directFilterChild: isDirectChild(element, of: filters[0].element) && directToolbar
        && feedbackSortControls.count == 1
        && role(feedbackSortControls[0].element) == "AXPopUpButton"
        && isDirectChild(feedbackSortControls[0].element, of: filters[0].element),
      childCount: childCount, hasURL: hasURL)
    passiveKinds.append(reset ? "reset" : feedback ? "feedback" : nil)
    return record
  }
  let ids = scope.map { $0["id"] as! String }
  try require(
    searchScopeIDsValid(ids, passiveKinds: passiveKinds) && sortControls.count == 1,
    "Search filter/sort controls cannot be identified uniquely")
  // Known passive controls retain their real empty IDs and complete state.
  // Their labels order tied IDs; neither control is a pagination input target.
  scope.sort {
    let left = $0["id"] as! String
    let right = $1["id"] as! String
    return left == right ? ($0["label"] as! String) < ($1["label"] as! String) : left < right
  }
  let scopeKey = try JSONSerialization.data(withJSONObject: scope, options: [.sortedKeys])
  let lists = nodes.filter {
    role($0.element) == "AXList" && label($0.element).hasPrefix("Message results,")
  }
  try require(lists.count <= 1, "Multiple search result lists exposed")
  if lists.isEmpty {
    let empty = nodes.filter { classes($0.element).contains("c-empty_state") }
    if empty.isEmpty { throw SearchLoading() }
    try require(empty.count == 1, "Search empty state is ambiguous")
    try require(
      ancestor(empty[0].element, matching: { CFEqual($0, scopeParent) }) != nil,
      "Search empty state is outside the verified result container")
    let labels = try tree(empty[0].element).filter { role($0.element) == "AXStaticText" }
      .map { label($0.element) }
    try require(
      searchEmptyLabelsMatch(labels),
      "Search results are unavailable, not a verified empty result")
    return SearchPage(
      query: query, url: url.absoluteString, page: nil, pageCount: nil, resultKeys: [],
      scope: scope, scopeKey: scopeKey, emptyResults: true, nextControl: nil)
  }
  let list = lists[0].element
  guard let rawParent = attr(list, kAXParentAttribute),
    CFGetTypeID(rawParent) == AXUIElementGetTypeID(),
    let rawFilterParent = attr(filters[0].element, kAXParentAttribute),
    CFGetTypeID(rawFilterParent) == AXUIElementGetTypeID()
  else { throw Failure(description: "Search result container is unavailable") }
  let parent = rawParent as! AXUIElement
  try require(
    CFEqual(parent, rawFilterParent) && CFEqual(parent, scopeParent) && verifiedScopeOwner(parent),
    "Search results and pagination do not share the verified Search container")
  let (page, pageCount) = try searchPageNumbers(label(list))
  let rows = attr(list, kAXChildrenAttribute) as? [AXUIElement] ?? []
  if rows.isEmpty { throw SearchLoading() }
  try require(rows.count <= 100, "Search page exceeds the bounded result count")
  var keys: [String] = []
  for row in rows {
    let containers = try tree(row).filter { node in
      classes(node.element).contains("c-message_kit__actions")
        && ancestor(
          node.element,
          matching: { candidate in
            !CFEqual(candidate, node.element)
              && classes(candidate).contains("c-message_kit__actions")
          }) == nil
    }
    try require(containers.count == 1, "Search message container is absent or ambiguous")
    let headers = (attr(containers[0].element, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter
    {
      classes($0).contains("c-search_message__content_header")
    }
    try require(headers.count == 1, "Search result header is absent or ambiguous")
    let timestamps = try tree(headers[0]).filter { classes($0.element).contains("c-timestamp") }
    guard timestamps.count == 1, let link = messageLink(timestamps[0].element) else {
      throw Failure(description: "Search result has no unique observed message permalink")
    }
    keys.append("\(link.host):\(link.conversationId):\(link.messageTS)")
  }
  let pagers = (attr(parent, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
    role($0) == "AXToolbar" && label($0) == "Pagination"
  }
  try require(pagers.count <= 1, "Search pagination toolbar is ambiguous")
  let next = pagers.flatMap { attr($0, kAXChildrenAttribute) as? [AXUIElement] ?? [] }.filter {
    role($0) == "AXButton" && label($0) == "Next page"
  }
  try require(next.count <= 1, "Search next-page control is ambiguous")
  let previous = pagers.flatMap { attr($0, kAXChildrenAttribute) as? [AXUIElement] ?? [] }.filter {
    role($0) == "AXButton" && label($0) == "Previous page"
  }
  if page == pageCount, let control = next.first {
    try require(
      (attr(control, kAXEnabledAttribute) as? Bool) == false,
      "Search last-page count disagrees with its next-page control")
  }
  return SearchPage(
    query: query, url: url.absoluteString, page: page, pageCount: pageCount, resultKeys: keys,
    scope: scope, scopeKey: scopeKey, emptyResults: false, nextControl: next.first,
    previousControl: previous.count == 1 ? previous[0] : nil)
}
func firstSearchPage(_ workspace: Workspace, _ query: String, inputDeadline: Date? = nil) throws
  -> SearchPage
{
  var deadline = min(Date().addingTimeInterval(5), inputDeadline ?? .distantFuture)
  var stable: SearchPage?
  // Resubmitting the query Slack is already showing keeps its current result
  // page. A later page that holds still for this exact query is walked back
  // with its own Previous page control, one verified step at a time.
  var later: SearchPage?
  var rewinds = 0
  repeat {
    try sampleDesktop("verify-first-search-page")
    do {
      let observed = try searchPage(workspace.root(), query)
      if observed.emptyResults || observed.page == 1 {
        if let stable, observed.sameContent(stable) { return observed }
        stable = observed
        later = nil
      } else {
        stable = nil
        if let held = later, observed.sameContent(held), let control = observed.previousControl,
          let page = observed.page, page > 1, rewinds < 20
        {
          try requireNoModal(workspace.window)
          try press(control, inputDeadline: inputDeadline)
          rewinds += 1
          later = nil
          deadline = min(Date().addingTimeInterval(5), inputDeadline ?? .distantFuture)
        } else {
          later = observed
        }
      }
    } catch is SearchLoading {
      stable = nil
      later = nil
    }
    settle()
  } while Date() < deadline
  throw Failure(
    description:
      "Search submission did not settle on its first result page; no result-page action posted")
}
func advanceSearchPage(_ previous: SearchPage, _ workspace: Workspace, inputDeadline: Date? = nil)
  throws -> SearchPage
{
  guard let expected = previous.nextPage else {
    throw Failure(description: "Search does not expose a next result page")
  }
  _ = try windowId(workspace.window, workspace.pid)
  try requireNoModal(workspace.window)
  try sampleDesktop("before-search-page")
  let fresh = try searchPage(workspace.root(), previous.query)
  try require(
    fresh.sameContent(previous), "Search results or scope changed before paging; no input posted")
  guard let control = fresh.nextControl else {
    throw Failure(description: "Search next-page control is unavailable; no input posted")
  }
  try press(control, inputDeadline: inputDeadline)
  let deadline = min(Date().addingTimeInterval(5), inputDeadline ?? .distantFuture)
  var stable: SearchPage?
  repeat {
    settle()
    try sampleDesktop("verify-search-page")
    do {
      let observed = try searchPage(workspace.root(), previous.query)
      try require(
        observed.url == previous.url && observed.scopeKey == previous.scopeKey
          && observed.pageCount == previous.pageCount && !observed.emptyResults,
        "Search scope or page count changed after paging")
      try require(
        observed.page == previous.page || observed.page == expected,
        "Search advanced to an unexpected result page")
      if observed.page == expected && observed.resultKeys != previous.resultKeys {
        if let stable, observed.sameContent(stable) { return observed }
        stable = observed
      } else {
        stable = nil
      }
    } catch is SearchLoading { stable = nil }
  } while Date() < deadline
  throw Failure(
    description:
      "Next-page action attempted once, but a changed stable result page was not verified; inspect before retrying"
  )
}

func retryDMHubLoading<T>(_ deadline: Date, _ capture: () throws -> T, wait: () throws -> Void)
  throws -> T
{
  for attempt in 0..<3 {
    do { return try capture() } catch is DMHubLoading {
      guard attempt < 2, Date() < deadline else { throw DMHubLoading() }
      try wait()
      try require(Date() < deadline, "DMs-view recapture deadline reached; no input replayed")
    }
  }
  throw DMHubLoading()
}
func dmHubContent(_ workspace: Workspace, _ expected: ListingPage, deadline: Date) throws -> (
  content: [String: Any], page: ListingPage
) {
  try retryDMHubLoading(
    min(deadline, Date().addingTimeInterval(2)),
    {
      let before = try dmHubPage(workspace.root())
      try require(sameDMHubContent(before, expected), "DMs view changed before capture")
      let content = try contentSnapshot(workspace.root())
      let final = try dmHubPage(workspace.root())
      try require(sameDMHubContent(final, expected), "DMs view changed during capture")
      return (content, final)
    },
    wait: {
      settle()
      try sampleDesktop("recapture-loading-dms-view")
      recoverySteps.append("Recaptured loading DMs view without repeating input")
    })
}

// Commands the helper accepts, by how many positional arguments they take.
// The usage text and the validity check both read these lists.
let nativeBareCommands = [
  "inspect", "workspaces", "current-workspace", "channels", "dms", "close-thread",
  "close-members", "browse-channels", "browse-people",
]
let nativeTargetCommands = [
  "search", "channel", "read-channel", "read-dm", "read-thread", "read-media", "read-transcript",
  "save-media", "switch-workspace", "members", "send", "edit", "delete",
]
let nativeUsage =
  "Usage: inspect | workspaces | current-workspace | switch-workspace TARGET | channels | dms | close-thread | close-members | browse-channels | browse-people | read-channel NAME | read-dm NAME_OR_@HANDLE_OR_GROUP:ID | read-thread REF_OR_PERMALINK | read-media REF | read-transcript REF | save-media REF | members NAME | search QUERY | channel NAME | send #CHANNEL|NAME|@HANDLE|group:ID|thread:REF --text=TEXT [--allow-clipboard] | edit REF --text=TEXT | delete REF --confirm-delete | permissions [--request]"

// The command after its --workspace and --interaction prefixes, validated
// without touching Slack. The entry point runs exactly this, so tests can check
// every argument list the wrapper emits against it.
struct NativeRequest {
  var help = false
  var permissionsRequest: Bool?
  var arguments: [String] = []
  var uiOptions: UIOptions?
  var composeText: String?
  var page: PageRequest?
  var requestedPages = 1
  var pagesSeen = false
  var membersSeconds: String?
  var sinceEpoch: Double?
  var dmSearch: String?
  var allowClipboard = false
  var requestedThread: MessageLink?
  var requestedGroup: String?
  var requestedGroupName: String?
  var composeLink: MessageLink?
}
func parseNativeRequest(_ input: [String]) throws -> NativeRequest {
  var request = NativeRequest()
  var arguments = input
  request.uiOptions =
    arguments.first == "inspect" && arguments.count > 1
    ? try UIOptions(Array(arguments.dropFirst())) : nil
  if request.uiOptions != nil { arguments = ["inspect"] }
  let composition = try composeArguments(arguments)
  arguments = composition.arguments
  request.composeText = composition.text
  request.allowClipboard = composition.allowClipboard
  let positionalCount =
    ["channels", "dms", "browse-channels", "browse-people"].contains(arguments.first ?? "")
    ? 1 : 2
  if arguments.count > positionalCount
    && [
      "channels", "dms", "read-channel", "read-dm", "read-thread", "read-transcript", "search",
      "members", "browse-channels", "browse-people",
    ]
    .contains(
      arguments[0])
  {
    let flags = arguments.dropFirst(positionalCount)
    for flag in flags {
      if flag == "--allow-clipboard" {
        try require(!request.allowClipboard, "Specify --allow-clipboard only once")
        request.allowClipboard = true
      } else if flag.hasPrefix("--search=") {
        let value = String(flag.dropFirst("--search=".count))
        try require(
          arguments[0] == "dms" && request.dmSearch == nil
            && validDMSearchText(value, allowEmpty: true),
          "Use --search once with dms and at most 200 characters without controls")
        request.dmSearch = value
      } else if flag.hasPrefix("--pages=") {
        let value = String(flag.dropFirst("--pages=".count))
        try require(
          !request.pagesSeen
            && value.range(of: #"^(?:[1-9]|10)$"#, options: .regularExpression) != nil,
          "Specify --pages once with an integer from 1 to 10")
        request.requestedPages = Int(value)!
        request.pagesSeen = true
      } else if flag.hasPrefix("--max-seconds=") {
        try require(
          arguments[0] == "members" && request.membersSeconds == nil,
          "Use --max-seconds once with members only")
        let value = String(flag.dropFirst("--max-seconds=".count))
        _ = try membersRuntimeLimit(value, 0)
        request.membersSeconds = value
      } else if flag.hasPrefix("--since=") {
        let value = String(flag.dropFirst("--since=".count))
        try require(
          request.sinceEpoch == nil && ["read-channel", "read-dm"].contains(arguments[0])
            && value.range(of: #"^[1-9][0-9]{8,9}$"#, options: .regularExpression) != nil,
          "Specify --since once, as epoch seconds, with read-channel or read-dm")
        request.sinceEpoch = Double(value)!
      } else {
        try require(
          ![
            "search", "channels", "dms", "read-transcript", "members", "browse-channels",
            "browse-people",
          ].contains(arguments[0]),
          "Search, listing, read-transcript and members commands do not accept --before or --after")
        try require(request.page == nil, "Specify only one of --before or --after")
        request.page = try PageRequest(flag)
      }
    }
    arguments = Array(arguments.prefix(positionalCount))
  }
  request.arguments = arguments
  if arguments == ["--help"] {
    request.help = true
    return request
  }
  if arguments == ["permissions"] || arguments == ["permissions", "--request"] {
    request.permissionsRequest = arguments.count == 2
    return request
  }
  try require(
    (arguments.count == 1 && nativeBareCommands.contains(arguments[0]))
      || (arguments.count == 2 && nativeTargetCommands.contains(arguments[0])),
    nativeUsage
  )
  request.requestedThread =
    arguments[0] == "read-thread" ? try MessageLink(arguments[1]) : nil
  if ["read-media", "read-transcript", "save-media"].contains(arguments[0]) {
    try require(
      validMediaReference(arguments[1]),
      "Use an attachment's file ID or MESSAGE/mN reference from read/search output")
  }
  request.requestedGroup = arguments[0] == "read-dm" ? try groupDMIdentifier(arguments[1]) : nil
  request.requestedGroupName = arguments[0] == "read-dm" ? try groupDMName(arguments[1]) : nil
  try require(
    request.dmSearch == nil || request.dmSearch == "" || request.allowClipboard,
    "Direct DMs search requires --allow-clipboard")
  try require(
    request.requestedGroupName == nil || request.page != nil || request.allowClipboard,
    "Group-name lookup requires --allow-clipboard")
  try require(
    !request.allowClipboard || request.dmSearch != nil
      || (arguments[0] == "read-dm" && request.requestedGroup == nil)
      || (arguments[0] == "send" && !arguments[1].hasPrefix("#")
        && !arguments[1].hasPrefix("thread:") && !arguments[1].hasPrefix("group:")),
    "--allow-clipboard requires direct DMs search or a name/handle DM read or send")
  request.composeLink =
    ["edit", "delete"].contains(arguments[0])
    ? try MessageLink(arguments[1])
    : arguments[0] == "send" && arguments[1].hasPrefix("thread:")
      ? try MessageLink(String(arguments[1].dropFirst("thread:".count))) : nil
  return request
}

// MARK: - Command entry point
do {
  let (requestedWorkspace, scopedArguments) = try workspaceArguments(
    Array(CommandLine.arguments.dropFirst()))
  if let requestedWorkspace {
    let commandPosition = scopedArguments.first?.hasPrefix("--interaction=") == true ? 1 : 0
    nativeWorkspaceSelection = WorkspaceSelectionEvidence(
      requested: requestedWorkspace, operation: scopedArguments[commandPosition])
  }
  let (interactionMode, parsedArguments) = try interactionArguments(
    scopedArguments)
  if interactionMode == .foreground { foregroundInteraction = ForegroundInteraction() }
  let request = try parseNativeRequest(parsedArguments)
  let arguments = request.arguments
  let uiOptions = request.uiOptions
  let composeText = request.composeText
  let page = request.page
  let requestedPages = request.requestedPages
  let pagesSeen = request.pagesSeen
  let membersSeconds = request.membersSeconds
  let sinceEpoch = request.sinceEpoch
  let dmSearch = request.dmSearch
  let allowClipboard = request.allowClipboard
  if request.help {
    print(
      "Prefix --workspace=TARGET after optional --interaction=MODE to select one exact workspace before channels, dms, search, channel, read-channel, read-dm, read-thread, read-media, read-transcript or save-media. Selection and requested work share one process; paging and downloads never re-select after drift. Other commands reject the workspace prefix."
    )
    print(
      "workspaces | current-workspace | switch-workspace TARGET: list observed signed-in workspace domains, inspect the current client context, or switch once to an exact observed name/domain. No pagination or clipboard flags. Only switch-workspace accepts explicit foreground mode; background remains default."
    )
    print(
      "slack.swift inspect [--ui [--filter=TEXT] [--limit=1..500] [--depth=0..40] [--prepare]] | channels | dms [--search=TEXT --allow-clipboard] | read-channel NAME | read-dm NAME_OR_@HANDLE_OR_GROUP:ID_OR_GROUP-NAME:NAME [--allow-clipboard] | read-thread REF_OR_PERMALINK | read-media REF | read-transcript REF | save-media REF | search QUERY | channel NAME | send #CHANNEL|NAME|@HANDLE|group:ID|thread:REF --text=TEXT [--allow-clipboard] | edit REF --text=TEXT | delete REF --confirm-delete | permissions [--request]\nchannels lists exposed sidebar channels; dms lists the current DMs view and preserves its filters; read commands return currently loaded messages, not full history. Duplicate DM names require an exact @handle; group DMs use the group:ID reference emitted by dms. Channels, dms, conversation/thread reads, search and read-transcript accept --pages=1..10; transcript paging uses only scoped AXScrollToVisible and never presses timestamp/text buttons; read-media inspects currently exposed attachment metadata without input and accepts no paging flags; only conversation/thread reads accept --before=REF or --after=REF.\npermissions checks process trust and bounded real Slack AX role/children reads without input, scoped to the current execution context. Verify approved host execution before treating denied access as missing macOS setup. ready also requires post-event access; readable AX without it is inspection-only (exit 0). Missing trust or AX API disabled exits 3; missing/ambiguous Slack or other failed AX probes report unavailable and exit 1. --request explicitly requests the permission prompt/settings for missing trust or an API-disabled probe; it never grants access or resumes a command.\nsave-media requests one verified Download control after wrapper authorization and monitors background state until wrapper completion; it never opens the saved file.\nBackground is the default and never activates or raises windows, moves the cursor or opens settings. Prefix --interaction=foreground explicitly activates the pinned running Slack app once for a navigation/read/search/save command, then keeps the same source-verified AX and window/PID-targeted input. It leaves current focus unchanged afterward and stops on an observed app switch; no command is replayed automatically. inspect, read-media and permissions do not accept foreground interaction. Keys are window/PID-targeted after verifying the exact control. Direct DMs autocomplete search uses guarded temporary clipboard contents and Shift+Insert only with --allow-clipboard; --search= clears the query without clipboard use. Output is private live UI content."
    )
    exit(0)
  }
  if let permissionsRequest = request.permissionsRequest {
    exit(try permissions(request: permissionsRequest))
  }
  let requestedThread = request.requestedThread
  let requestedGroup = request.requestedGroup
  let requestedGroupName = request.requestedGroupName
  let composeLink = request.composeLink
  var batchDeadline = Date().addingTimeInterval(60)
  if !AXIsProcessTrusted() {
    exit(try permissions(request: false))
  }
  let apps = NSRunningApplication.runningApplications(
    withBundleIdentifier: "com.tinyspeck.slackmacgap"
  ).filter { !$0.isTerminated }
  try require(apps.count == 1, "Expected one running Slack desktop app")
  let running = apps[0]
  let app = AXUIElementCreateApplication(apps[0].processIdentifier)
  diagnosticApp = app
  diagnosticExpectedScope = ["operation": arguments[0]]
  slackPid = running.processIdentifier
  let foregroundBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let cursorBefore = CGEvent(source: nil)?.location ?? .zero
  initialForeground = foregroundBefore
  try sampleDesktop("start")
  let accessibilityProbe = slackAXProbe(app, running.processIdentifier)
  if let uiOptions {
    if uiOptions.prepare && !accessibilityProbe.accessible {
      recoverySteps.append(
        "Withheld Electron accessibility initialization because AX access is unverified")
    }
    var receipt = try uiInspection(
      app, running.processIdentifier, uiOptions, accessibilityReady: accessibilityProbe.accessible)
    receipt["accessibilityProbe"] = accessibilityProbe.receipt
    if !accessibilityProbe.accessible {
      receipt["status"] = "stopped"
      receipt["accessStatus"] = accessibilityProbe.accessStatus
      receipt["error"] = accessibilityProbe.message
      receipt["next"] = accessibilityProbe.next
    }
    try emit(receipt)
    exit(accessibilityProbe.exitCode)
  }
  if !accessibilityProbe.accessible { throw SlackAXAccessFailure(probe: accessibilityProbe) }
  try prepareAccessibility(app)
  let operation = arguments[0]
  let listingOperation = ["channels", "dms"].contains(operation)
  let structured =
    listingOperation || ["read-channel", "read-dm", "read-thread"].contains(operation)
  var workspace: Workspace?
  if operation == "inspect" {
    workspace = try? Workspace(app, running.processIdentifier)
  } else {
    workspace = try Workspace(app, running.processIdentifier)
  }
  if let workspace {
    diagnosticExpectedScope["workspaceContext"] =
      "/" + workspace.context.split(separator: "/").joined(separator: "/")
  }
  if let foregroundInteraction {
    guard let workspace else {
      throw Failure(description: "Foreground interaction requires a pinned workspace")
    }
    let launched = running.launchDate
    try foregroundInteraction.start(
      pid: running.processIdentifier, originalForeground: foregroundBefore,
      verify: {
        let current = NSRunningApplication.runningApplications(
          withBundleIdentifier: "com.tinyspeck.slackmacgap"
        ).filter { !$0.isTerminated }
        try require(
          !running.isTerminated && current.count == 1
            && current[0].processIdentifier == workspace.pid
            && current[0].launchDate == launched,
          "Slack process changed before foreground input")
        _ = try workspace.root()
      },
      foreground: { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 },
      interrupted: { interrupted },
      physicalInputIdle: {
        CGEventSource.flagsState(.combinedSessionState).intersection([
          .maskCommand, .maskControl, .maskAlternate, .maskShift,
        ]).isEmpty && NSEvent.pressedMouseButtons == 0
      },
      activate: { running.activate(options: []) },
      wait: { axPause(until: Date().addingTimeInterval(0.1)) })
    try sampleDesktop("foreground-ready")
  }
  if ["workspaces", "current-workspace", "switch-workspace"].contains(operation) {
    let result = try workspaceCommand(
      operation, arguments.count == 2 ? arguments[1] : nil, workspace!)
    try emit(result)
    exit(result["status"] as? String == "ok" ? 0 : 1)
  }
  if operation == "close-thread" {
    let result = try closeThread(workspace!)
    try emit(result)
    exit(result["status"] as? String == "ok" ? 0 : 1)
  }
  if operation == "close-members" {
    let result = try closeMembers(workspace!)
    try emit(result)
    exit(result["status"] as? String == "ok" ? 0 : 1)
  }
  if let requestedWorkspace {
    let original = workspace!
    let originalWindow = try windowId(original.window, original.pid)
    nativeWorkspaceSelection?.begin()
    let selection = try workspaceCommand("switch-workspace", requestedWorkspace, original)
    nativeWorkspaceSelection?.finish(selection)
    let expected = try workspaceSelectionDestination(
      selection, requested: requestedWorkspace, initialWindow: originalWindow)
    let selected = try Workspace(app, running.processIdentifier)
    try require(
      CFEqual(selected.window, original.window), "Workspace selection changed the native window")
    try require(
      try workspaceView(selected) == expected,
      "Workspace changed after selection; requested command was not started")
    // A selector inherited from the user is preserved by a no-op. It cannot be
    // dismissed implicitly merely to authorize the next command.
    try require(
      try workspaceSelector(selected) == nil,
      "Workspace selection preserved an open selector; requested command was not started. Close it explicitly before another request"
    )
    try requireNoModal(selected.window)
    workspace = selected
    nativeSelectedWorkspace = selected
    nativeWorkspaceScopeWindow = expected.windowId
    diagnosticExpectedScope["workspaceContext"] = "/client/" + expected.contextId
    batchDeadline = Date().addingTimeInterval(60)
    try sampleDesktop("workspace-selection-complete")
  }
  if ["send", "edit", "delete"].contains(operation) {
    var result: [String: Any]
    var destination: [String: Any] = [:]
    if operation == "send" {
      let requested = arguments[1]
      if let composeLink {
        destination = try readThread(composeLink, workspace!, running)
      } else if requested.hasPrefix("#") {
        destination = try search(
          String(requested.dropFirst()), workspace!, running, kind: .channel)
      } else if let group = try groupDMIdentifier(requested) {
        destination = try readGroupDM(group, workspace!, running)
      } else {
        destination = try readIndividualDM(
          requested, workspace!, running, allowClipboard: allowClipboard)
      }
      result = try sendMessage(composeText!, destination, workspace!)
    } else if operation == "edit" {
      result = try editMessage(composeLink!, composeText!, workspace!, running)
    } else {
      result = try deleteMessage(composeLink!, workspace!, running)
    }
    let root = try workspace!.root()
    result["operation"] = operation
    result["requested"] = arguments[1]
    result["pid"] = running.processIdentifier
    result["destination"] = destination
    result["after"] = identity(root)
    result["recovery"] = recoverySteps
    result["desktop"] = [
      "samples": desktopSamples, "scope": "bounded desktop samples, not continuous proof",
    ]
    try emit(result)
    exit(0)
  }
  if operation == "read-transcript" {
    exit(Int32(try readExistingTranscript(arguments[1], workspace!, requestedPages)))
  }
  if operation == "save-media" {
    exit(Int32(try saveMedia(arguments[1], workspace!)))
  }
  if operation == "read-media" {
    let first = try mediaObservation(workspace!)
    try sampleDesktop("media-first-capture")
    let second = try mediaObservation(workspace!)
    try sampleDesktop("media-final-capture")
    try emit([
      "operation": operation, "requested": arguments[1], "pid": running.processIdentifier,
      "observations": [first, second], "recovery": recoverySteps,
      "desktop": [
        "samples": desktopSamples,
        "scope": "bounded desktop samples, not continuous proof",
      ],
      "verification": "Two read-only captures; reference binding is verified by the wrapper",
    ])
    exit(0)
  }
  let before = try structured ? identity(workspace!.root()) : snapshot(app)
  var target: [String: Any] = [:]
  if operation == "search" { _ = try search(arguments[1], workspace!, running) }
  if let page {
    target = try continuationTarget(workspace!.root(), operation, arguments[1], page)
  }
  if page == nil && (operation == "channel" || operation == "read-channel") {
    let query = arguments[1].hasPrefix("#") ? String(arguments[1].dropFirst()) : arguments[1]
    target = try search(query, workspace!, running, kind: .channel)
  }
  if operation == "browse-channels" || operation == "browse-people" {
    let tab = operation == "browse-channels" ? "channels" : "people"
    let result = try browseDirectory(tab, workspace!, running, pagesSeen ? requestedPages : 10)
    try emit(result)
    exit(result["status"] as? String == "ok" ? 0 : 1)
  }
  if operation == "members" {
    let query = arguments[1].hasPrefix("#") ? String(arguments[1].dropFirst()) : arguments[1]
    let channel = try search(query, workspace!, running, kind: .channel)
    // Without --pages, read until the whole advertised member list is collected.
    let memberPages = pagesSeen ? requestedPages : 0
    let result = try readChannelMembers(
      channel, workspace!, memberPages, membersRuntimeLimit(membersSeconds, memberPages))
    try emit(result)
    exit(result["status"] as? String == "ok" ? 0 : 1)
  }
  if page == nil && operation == "read-dm" {
    target =
      try requestedGroupName.map { try readGroupDMByName($0, workspace!, running) }
      ?? requestedGroup.map { try readGroupDM($0, workspace!, running) }
      ?? readIndividualDM(arguments[1], workspace!, running, allowClipboard: allowClipboard)
  }
  if page == nil && (operation == "read-channel" || operation == "read-dm") {
    try scrollToNewest(workspace!, target)
  }
  if page == nil, let requestedThread {
    target = try readThread(requestedThread, workspace!, running)
  }
  if operation == "channels" { try ensureSidebar(workspace!, running) }
  if operation == "dms", let dmSearch {
    if dmSearch.isEmpty {
      try ensureDMHub(workspace!, running)
      let (_, context) = try dmQueryContext(workspace!, allowExistingSelection: true)
      try ensureSidebar(workspace!, running)
      try ensureDMHub(workspace!, running)
      let (field, after) = try dmQueryContext(workspace!)
      try require(
        NSDictionary(dictionary: context).isEqual(to: after) && (try managedDMQuery(field)).isEmpty,
        "DMs query clear did not verify")
    } else {
      let first = try prepareDMSearch(workspace!, running, dmSearch)
      let result = try collectDMSearch(first, workspace!, dmSearch, requestedPages)
      try emit(result)
      exit(result["status"] as? String == "partial" ? 1 : 0)
    }
  }
  if operation == "dms" { try ensureDMHub(workspace!, running) }
  func capturePage(
    _ page: PageRequest?, _ target: [String: Any], _ requestedThread: MessageLink?,
    _ before: [String: Any], _ foregroundBefore: pid_t, _ cursorBefore: CGPoint,
    _ sampleOffset: Int
  ) throws -> (receipt: [String: Any], threadReplyCount: Int?) {
    var threadReplyCount: Int?
    var extra: [String: Any] = [:]
    let observedDMs = operation == "dms" ? try firstDMHubPage(workspace!) : nil
    if let observedDMs {
      let captured = try dmHubContent(workspace!, observedDMs, deadline: batchDeadline)
      extra["content"] = captured.content
      extra["dmPagination"] = captured.page.receipt(nil, "initial", "dms")
      extra["target"] = target
    } else if structured {
      let root = try workspace!.root()
      let observedURL = (attr(root, kAXURLAttribute) as? URL)?.absoluteString
      if operation == "read-channel" || operation == "read-dm" {
        let deadline = Date().addingTimeInterval(4)
        func hasMessages() throws -> Bool {
          try messagesReady(workspace!.root(), target)
        }
        while !(try hasMessages()) && Date() < deadline {
          settle()
          try sampleDesktop("wait-messages")
        }
        try require(
          try hasMessages(),
          "No loaded message rows observed before the deadline; conversation may be empty or still loading. Inspect current state; no empty-history claim returned"
        )
      }
      if !listingOperation { extra["pagination"] = try paginate(workspace!, target, page) }
      let captureRoot = try workspace!.root()
      extra["content"] = try contentSnapshot(captureRoot)
      let afterRoot = try workspace!.root()
      try require(
        try queryFields(afterRoot).isEmpty,
        "Query overlay appeared during capture; no structured output returned")
      try require(
        observedURL != nil
          && (attr(captureRoot, kAXURLAttribute) as? URL)?.absoluteString == observedURL
          && (attr(afterRoot, kAXURLAttribute) as? URL)?.absoluteString == observedURL
          && (listingOperation || target["url"] as? String == observedURL),
        "Conversation changed during capture; no structured output returned")
      if let requestedThread {
        let current = try threadView(afterRoot)
        threadReplyCount = current?.replyCount
        try require(
          current?.matches(requestedThread) == true
            && current?.header.messageTS == target["rootTS"] as? String
            && current?.header.host == target["requestedHost"] as? String
            && current?.loaded == true,
          "Thread changed during capture; no thread content returned")
      }
      if let pagination = extra["pagination"] as? [String: Any],
        let expected = pagination["afterTimestamps"] as? [String]
      {
        try require(
          try pageRows(afterRoot, target).map { $0.timestamp } == expected,
          "Message page changed during capture; read again for fresh page references")
      }
      extra["target"] = target
    } else if let root = try workspace?.root() {
      // The wrapper formats these observations; the full receipt remains opt-in.
      extra["content"] = try contentSnapshot(root)
      if operation == "channel" { extra["target"] = target }
    }
    let after = try structured ? identity(workspace!.root()) : snapshot(app)
    let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    let cursorAfter = CGEvent(source: nil)?.location ?? .zero
    try sampleDesktop("finish")
    var receipt: [String: Any] = [
      "desktop": [
        "foregroundBefore": foregroundBefore, "foregroundAfter": foregroundAfter,
        "cursorBefore": [cursorBefore.x, cursorBefore.y],
        "cursorAfter": [cursorAfter.x, cursorAfter.y],
        "samples": Array(desktopSamples.dropFirst(sampleOffset)),
        "scope":
          "before/after and per-action samples, not continuous proof; user app switching is allowed",
      ], "operation": operation, "pid": running.processIdentifier, "before": before, "after": after,
      "verification":
        "Inspect after-state for requested channel/query/messages; an accepted action alone is not success",
    ]
    receipt["recovery"] = recoverySteps
    receipt.merge(extra) { _, new in new }
    if let dmSearch {
      let (field, _) = try dmQueryContext(workspace!)
      try require(try managedDMQuery(field) == dmSearch, "DMs query changed during collection")
      receipt["dmSearch"] = ["requested": dmSearch, "verified": true]
    }
    return (receipt, threadReplyCount)
  }
  if requestedPages == 1 {
    try emit(
      capturePage(page, target, requestedThread, before, foregroundBefore, cursorBefore, 0).receipt)
  } else if listingOperation {
    var pages: [[String: Any]] = []
    var attemptedPages = 0
    var stopReason = "page-limit"
    var failure: String?
    var previous: ListingPage?
    var sectionStates: [String: Data] = [:]
    var dmIdentityStates: [String: SidebarDM] = [:]
    let listingName = operation == "dms" ? "DMs view" : "sidebar"
    while pages.count < requestedPages {
      if !pages.isEmpty && Date() >= batchDeadline {
        stopReason = "time-limit"
        failure =
          "Multi-page \(listingName) read reached its 60-second budget; prior verified pages retained"
        break
      }
      attemptedPages += 1
      let sampleOffset = pages.isEmpty ? 0 : desktopSamples.count
      do {
        let pageBefore = pages.isEmpty ? before : try identity(workspace!.root())
        let pageForeground =
          pages.isEmpty
          ? foregroundBefore : NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let pageCursor = pages.isEmpty ? cursorBefore : CGEvent(source: nil)?.location ?? .zero
        if !pages.isEmpty { try sampleDesktop("start-\(listingName)-page") }
        let observed: ListingPage
        let status: String
        if let previous {
          (observed, status) =
            try operation == "dms"
            ? advanceDMHubPage(previous, workspace!) : advanceSidebarPage(previous, workspace!)
        } else {
          observed =
            try operation == "dms" ? firstDMHubPage(workspace!) : firstSidebarPage(workspace!)
          status = "initial"
        }
        for (id, state) in observed.sections {
          if let pinned = sectionStates[id] {
            try require(pinned == state, "Previously observed sidebar section changed")
          }
        }
        if operation == "dms" {
          for (id, identity) in observed.dmIdentities {
            try require(
              dmIdentityStates[id] == nil || dmIdentityStates[id] == identity,
              "Previously observed DM identity changed")
          }
        }
        let captured =
          operation == "dms"
          ? try dmHubContent(workspace!, observed, deadline: batchDeadline) : nil
        let content = try captured?.content ?? contentSnapshot(workspace!.root())
        let after = try identity(workspace!.root())
        let final = try captured?.page ?? sidebarPage(workspace!.root())
        try require(
          operation == "dms" ? sameDMHubContent(final, observed) : final.sameContent(observed),
          operation == "dms" ? "DMs view changed during capture" : "Sidebar changed during capture")
        try sampleDesktop("finish")
        let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let cursorAfter = CGEvent(source: nil)?.location ?? .zero
        pages.append([
          "operation": operation, "pid": running.processIdentifier, "before": pageBefore,
          "after": after, "content": content, "target": target,
          operation == "dms" ? "dmPagination" : "channelPagination": final.receipt(
            previous, status, operation),
          "recovery": recoverySteps,
          "desktop": [
            "foregroundBefore": pageForeground, "foregroundAfter": foregroundAfter,
            "cursorBefore": [pageCursor.x, pageCursor.y],
            "cursorAfter": [cursorAfter.x, cursorAfter.y],
            "samples": Array(desktopSamples.dropFirst(sampleOffset)),
            "scope":
              "before/after and per-action samples, not continuous proof; user app switching is allowed",
          ],
          "verification":
            operation == "dms"
            ? "DMs view, workspace, filters and observed conversation identities verified before and after capture"
            : "Sidebar workspace, filter, section state and observed row identities verified before and after capture"
            ,
        ])
        if let dmSearch {
          let (field, _) = try dmQueryContext(workspace!)
          try require(try managedDMQuery(field) == dmSearch, "DMs query changed during collection")
          pages[pages.count - 1]["dmSearch"] = ["requested": dmSearch, "verified": true]
        }
        sectionStates.merge(final.sections) { existing, _ in existing }
        dmIdentityStates.merge(final.dmIdentities) { existing, _ in existing }
        previous = final
        if status == "no-progress" {
          stopReason = "no-progress"
          break
        }
      } catch {
        if pages.isEmpty { throw error }
        stopReason = "error"
        failure = String(describing: error)
        break
      }
    }
    var batch: [String: Any] = [
      "operation": operation, "pid": running.processIdentifier,
      "status": failure == nil ? "ok" : "partial", "pages": pages,
      "batch": [
        "requestedPages": requestedPages, "attemptedPages": attemptedPages,
        "completedPages": pages.count, "direction": "down", "stopReason": stopReason,
      ],
    ]
    if let dmSearch { batch["dmSearch"] = ["requested": dmSearch, "verified": true] }
    if let failure {
      if let observation = afterErrorObservation() { batch["observation"] = observation }
      batch["error"] = failure
      batch["next"] =
        "Inspect the current Slack \(listingName) before resuming; do not replay input blindly"
      batch["desktopSamples"] = desktopSamples
    }
    try emit(batch)
    if failure != nil { exit(1) }
  } else if operation == "search" {
    var pages: [[String: Any]] = []
    var attemptedPages = 0
    var stopReason = "page-limit"
    var failure: String?
    var previous: SearchPage?
    var seen = Set<String>()
    while pages.count < requestedPages {
      if !pages.isEmpty && Date() >= batchDeadline {
        stopReason = "time-limit"
        failure = "Multi-page search reached its 60-second budget; prior verified pages retained"
        break
      }
      attemptedPages += 1
      let sampleOffset = pages.isEmpty ? 0 : desktopSamples.count
      do {
        let pageBefore = pages.isEmpty ? before : try snapshot(app)
        let pageForeground =
          pages.isEmpty
          ? foregroundBefore : NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let pageCursor = pages.isEmpty ? cursorBefore : CGEvent(source: nil)?.location ?? .zero
        if !pages.isEmpty { try sampleDesktop("start-search-page") }
        let observed =
          try previous.map { try advanceSearchPage($0, workspace!) }
          ?? firstSearchPage(workspace!, arguments[1])
        if pages.isEmpty {
          try require(
            observed.emptyResults || observed.page == 1,
            "Search did not begin at its first result page")
        }
        let content = try contentSnapshot(workspace!.root())
        let after = try snapshot(app)
        let final = try searchPage(workspace!.root(), arguments[1])
        try require(final.sameContent(observed), "Search results changed during capture")
        try sampleDesktop("finish")
        let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let cursorAfter = CGEvent(source: nil)?.location ?? .zero
        pages.append([
          "operation": operation, "pid": running.processIdentifier, "before": pageBefore,
          "after": after, "content": content,
          "searchPagination": final.receipt(pages.isEmpty ? 0 : 1),
          "recovery": recoverySteps,
          "desktop": [
            "foregroundBefore": pageForeground, "foregroundAfter": foregroundAfter,
            "cursorBefore": [pageCursor.x, pageCursor.y],
            "cursorAfter": [cursorAfter.x, cursorAfter.y],
            "samples": Array(desktopSamples.dropFirst(sampleOffset)),
            "scope":
              "before/after and per-action samples, not continuous proof; user app switching is allowed",
          ],
          "verification":
            "Search query, scope, page number and observed message identities verified before and after capture",
        ])
        let unseen = final.resultKeys.filter { !seen.contains($0) }
        seen.formUnion(final.resultKeys)
        if pages.count > 1 && unseen.isEmpty {
          stopReason = "no-progress"
          break
        }
        if final.nextPage == nil {
          stopReason = "no-next-page"
          break
        }
        previous = final
      } catch {
        if pages.isEmpty { throw error }
        stopReason = "error"
        failure = String(describing: error)
        break
      }
    }
    var batch: [String: Any] = [
      "operation": operation, "pid": running.processIdentifier,
      "status": failure == nil ? "ok" : "partial", "pages": pages,
      "batch": [
        "requestedPages": requestedPages, "attemptedPages": attemptedPages,
        "completedPages": pages.count, "direction": "next", "stopReason": stopReason,
      ],
    ]
    if let failure {
      if let observation = afterErrorObservation() { batch["observation"] = observation }
      batch["error"] = failure
      batch["next"] =
        "Inspect current Slack search state before resuming; do not replay input blindly"
      batch["desktopSamples"] = desktopSamples
    }
    try emit(batch)
    if failure != nil { exit(1) }
  } else {
    let direction = page?.direction ?? (operation == "read-thread" ? "newer" : "older")
    var pages: [[String: Any]] = []
    var attemptedPages = 0
    var stopReason = "page-limit"
    var failure: String?
    var currentPage = page
    var currentTarget = target
    var currentThread = requestedThread
    var currentBefore = before
    var currentForeground = foregroundBefore
    var currentCursor = cursorBefore
    var sampleOffset = 0
    while pages.count < requestedPages {
      if !pages.isEmpty && Date() >= batchDeadline {
        stopReason = "time-limit"
        failure = "Multi-page read reached its 60-second budget; prior verified pages retained"
        break
      }
      attemptedPages += 1
      do {
        if !pages.isEmpty {
          // Preserve the original Workspace and initial foreground baseline.
          // Reacquisition checks app/window/workspace before another page.
          sampleOffset = desktopSamples.count
          currentForeground = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
          currentCursor = CGEvent(source: nil)?.location ?? .zero
          try sampleDesktop("start-page")
          currentBefore = identity(try workspace!.root())
        }
        let captured = try capturePage(
          currentPage, currentTarget, currentThread, currentBefore, currentForeground,
          currentCursor, sampleOffset)
        pages.append(captured.receipt)
        guard let pagination = captured.receipt["pagination"] as? [String: Any],
          let timestamps = pagination["afterTimestamps"] as? [String]
        else { throw Failure(description: "Verified pagination receipt is unavailable") }
        if pagination["status"] as? String == "no-progress" {
          stopReason = "no-progress"
          break
        }
        // Older paging has reached the requested start: no further page is read.
        if let sinceEpoch, direction == "older",
          let oldest = timestamps.compactMap(Double.init).min(), oldest <= sinceEpoch
        {
          stopReason = "since-reached"
          break
        }
        let isThread = operation == "read-thread"
        let rootTS = currentTarget["rootTS"] as? String
        let boundary = batchBoundary(
          timestamps, currentPage, isThread, rootTS, captured.threadReplyCount, direction)
        if boundary == nil {
          stopReason = "no-next-page"
          break
        }
        if pages.count == requestedPages { break }
        let conversation =
          isThread
          ? currentTarget["conversationId"] as? String
          : (currentTarget["url"] as? String).flatMap { URL(string: $0)?.lastPathComponent }
        guard let conversation else {
          throw Failure(description: "Pagination conversation identity disappeared")
        }
        currentPage = try PageRequest(
          "--\(direction == "older" ? "before" : "after")=\(conversation):\(boundary!)")
        if isThread, let rootTS {
          // The initial addressed reply was verified on page one. Later pages
          // follow its verified root even when that reply leaves the viewport.
          let rootRef = "\(conversation):\(rootTS)"
          currentThread = try MessageLink(rootRef)
          currentTarget["requestedMessageTS"] = rootTS
          currentTarget["requestedURL"] = rootRef
        }
      } catch {
        if pages.isEmpty { throw error }
        stopReason = "error"
        failure = String(describing: error)
        break
      }
    }
    var batch: [String: Any] = [
      "operation": operation, "pid": running.processIdentifier,
      "status": failure == nil ? "ok" : "partial", "pages": pages,
      "batch": [
        "requestedPages": requestedPages, "attemptedPages": attemptedPages,
        "completedPages": pages.count, "direction": direction, "stopReason": stopReason,
      ],
    ]
    if let failure {
      if let observation = afterErrorObservation() { batch["observation"] = observation }
      batch["error"] = failure
      batch["next"] = "Inspect current Slack state before resuming; do not replay input blindly"
      batch["desktopSamples"] = Array(desktopSamples.dropFirst(sampleOffset))
    }
    try emit(batch)
    if failure != nil { exit(1) }
  }
} catch {
  var exitCode: Int32 = 1
  var failure: [String: Any] = [
    "error": String(describing: error), "status": "stopped", "desktopSamples": desktopSamples,
    "recovery": recoverySteps,
    "next": "Inspect current Slack state before any retry; do not replay input blindly",
  ]
  if let access = error as? SlackAXAccessFailure {
    failure["accessibilityProbe"] = access.probe.receipt
    failure["accessStatus"] = access.probe.accessStatus
    failure["next"] = access.probe.next
    exitCode = access.probe.exitCode
  }
  if let observation = afterErrorObservation() { failure["observation"] = observation }
  if let readback = error as? ReadbackFailure {
    failure["actionMayHaveOccurred"] = false
    failure["readback"] = readback.readback
  }
  if let compose = error as? ComposeFailure {
    failure["actionMayHaveOccurred"] = compose.actionMayHaveOccurred
    failure["next"] =
      "Read the conversation to check whether the action took effect before any retry; nothing is replayed automatically"
  }
  if let choices = error as? DestinationChoiceFailure {
    failure["status"] =
      choices.incomplete ? "stopped" : choices.ambiguous ? "ambiguous" : "not-found"
    failure["query"] = choices.query
    failure["candidates"] = choices.candidates
    failure["candidateCount"] = choices.candidateCount
    failure["candidatesTruncated"] = choices.candidateCount > choices.candidates.count
    failure["exactMatchCount"] = choices.exactMatchCount
    failure["next"] =
      choices.candidates.isEmpty
      ? "Check the name or current workspace, then run read-dm with an exact display name or known @handle. No destination was selected."
      : "Use the intended person's observed @handle with read-dm. Available candidates are suggestions, not an automatic selection."
    if dmFallbackEligible(choices, choices.query, true) && clipboardRestoration == nil {
      failure["next"] =
        (failure["next"] as! String)
        + " If temporary clipboard use is authorized, retry the same read-dm with --allow-clipboard for direct DMs search."
    }
  }
  try? emit(failure)
  exit(exitCode)
}
