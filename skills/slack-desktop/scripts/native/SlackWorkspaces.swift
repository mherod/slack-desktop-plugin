import AppKit
import ApplicationServices

let workspaceScopedCommands = Set([
  "channels", "dms", "search", "channel", "read-channel", "read-dm", "read-thread",
  "read-media", "read-transcript", "save-media", "members", "browse-channels", "browse-people",
  "send", "edit", "delete",
])
func workspaceArguments(_ input: [String]) throws -> (String?, [String]) {
  let position = input.first?.hasPrefix("--interaction=") == true ? 1 : 0
  guard input.indices.contains(position), input[position].hasPrefix("--workspace") else {
    return (nil, input)
  }
  try require(
    input[position].hasPrefix("--workspace="), "Use native --workspace=TARGET before the command")
  let target = String(input[position].dropFirst("--workspace=".count))
  try require(
    validWorkspaceName(target), "Workspace target requires 1–200 characters without controls")
  var arguments = input
  arguments.remove(at: position)
  try require(
    arguments.indices.contains(position) && workspaceScopedCommands.contains(arguments[position]),
    "--workspace requires channels, dms, search, channel, a conversation/media/transcript read, or save-media"
  )
  return (target, arguments)
}
struct WorkspaceSelectionEvidence {
  let requested: String
  let operation: String
  var selection: [String: Any]?
  var mayHaveBeenRequested: Bool? = false
  mutating func begin() { mayHaveBeenRequested = nil }
  mutating func finish(_ value: [String: Any]) {
    selection = value
    if value["switchAttempted"] as? Bool == true
      || value["workspaceSwitchMayHaveBeenRequested"] as? Bool == true
    {
      mayHaveBeenRequested = true
    } else if value["switchAttempted"] as? Bool == false
      && value["workspaceSwitchMayHaveBeenRequested"] as? Bool == false
    {
      mayHaveBeenRequested = false
    } else {
      mayHaveBeenRequested = nil
    }
  }
  func decorate(_ value: [String: Any]) -> [String: Any] {
    var receipt = value
    receipt["requestedWorkspace"] = requested
    if receipt["operation"] == nil { receipt["operation"] = operation }
    if let selection { receipt["workspaceSelection"] = selection }
    receipt["workspaceSwitchMayHaveBeenRequested"] = mayHaveBeenRequested as Any? ?? NSNull()
    return receipt
  }
}
var nativeWorkspaceSelection: WorkspaceSelectionEvidence?
var nativeSelectedWorkspace: Workspace?
var nativeWorkspaceScopeWindow: Int?

struct WorkspaceRow: Equatable {
  let name: String
  // The pop-up selector exposes a domain; the workspace rail exposes names only.
  let domain: String?
  let current: Bool
  var receipt: [String: Any] {
    ["name": name, "domain": domain as Any? ?? NSNull(), "current": current]
  }
}
struct WorkspaceView: Equatable {
  let url: String
  let name: String
  let windowId: Int
  var contextId: String { (try? workspaceContext(url)) ?? "" }
  func receipt(_ rows: [WorkspaceRow]? = nil) -> [String: Any] {
    var value: [String: Any] = ["url": url, "name": name, "windowId": windowId]
    if let rows { value["entries"] = rows.map { $0.receipt } }
    return value
  }
}
func workspaceReceiptView(_ value: Any?) throws -> (WorkspaceView, [WorkspaceRow]) {
  guard let value = value as? [String: Any], let url = value["url"] as? String,
    let name = value["name"] as? String, let window = value["windowId"] as? Int,
    let entries = value["entries"] as? [[String: Any]]
  else { throw Failure(description: "Workspace selection observation is incomplete") }
  _ = try workspaceContext(url)
  try require(validWorkspaceName(name) && window > 0, "Workspace selection observation is invalid")
  let rows = try entries.map { row -> WorkspaceRow in
    guard let name = row["name"] as? String, let current = row["current"] as? Bool,
      row["domain"] is String || row["domain"] is NSNull
    else { throw Failure(description: "Workspace selection row is incomplete") }
    return WorkspaceRow(name: name, domain: row["domain"] as? String, current: current)
  }
  try validateWorkspaceRows(rows, name)
  return (WorkspaceView(url: url, name: name, windowId: window), rows)
}
func workspaceSelectionDestination(
  _ receipt: [String: Any], requested: String, initialWindow: Int
) throws -> WorkspaceView {
  try require(
    receipt["operation"] as? String == "switch-workspace" && receipt["status"] as? String == "ok"
      && receipt["requested"] as? String == requested,
    "Workspace selection did not complete; requested command was not started")
  let (before, beforeRows) = try workspaceReceiptView(receipt["before"])
  let (after, afterRows) = try workspaceReceiptView(receipt["after"])
  try require(
    before.windowId == initialWindow && after.windowId == initialWindow,
    "Workspace selection belongs to another native window")
  let matches = workspaceMatches(beforeRows, requested, before.contextId)
  try require(matches.count == 1, "Workspace selection target is missing or ambiguous")
  let target = matches[0]
  guard let selected = receipt["selection"] as? [String: Any],
    let selector = receipt["selector"] as? [String: Any]
  else { throw Failure(description: "Workspace selection proof is incomplete") }
  try require(
    selected["name"] as? String == target.name && selected["domain"] as? String == target.domain,
    "Workspace selection target differs from the exact request")
  try verifyWorkspaceTransition(before, after, beforeRows, afterRows, target)
  let rail = selector["layout"] as? String == "rail"
  try require(
    receipt["switchAttempted"] as? Bool == !target.current
      && receipt["workspaceSwitchMayHaveBeenRequested"] as? Bool == !target.current
      && selector["verificationOpened"] as? Bool == (rail ? false : !target.current),
    "Workspace selection action evidence is inconsistent")
  try require(
    selector["opened"] as? Bool != nil && selector["reused"] as? Bool != nil
      && selector["closed"] as? Bool != nil,
    "Workspace selector ownership evidence is incomplete")
  let opened = selector["opened"] as! Bool
  let reused = selector["reused"] as! Bool
  let closed = selector["closed"] as! Bool
  // The rail is persistent: it is observed in place, never opened or closed.
  try require(
    rail
      ? reused && !opened && !closed
      : opened != reused && (closed || reused) && (target.current || closed),
    "Workspace selector ownership or closure was not verified")
  return after
}
func workspaceScopeFailure(_ value: [String: Any], _ error: String) -> [String: Any] {
  var receipt = value
  receipt.removeValue(forKey: "workspaceScope")
  receipt["status"] = "stopped"
  receipt["workspaceScopeError"] = error
  if receipt["error"] == nil { receipt["error"] = error }
  receipt["next"] =
    "Inspect the current workspace before another request; no automatic workspace re-selection was attempted."
  return receipt
}
func workspaceScopedEmission(_ value: [String: Any]) -> (receipt: [String: Any], scopeFailed: Bool)
{
  var receipt = nativeWorkspaceSelection?.decorate(value) ?? value
  guard let workspace = nativeSelectedWorkspace else { return (receipt, false) }
  do {
    let root = try workspace.root()
    guard let url = attr(root, kAXURLAttribute) as? URL else {
      throw Failure(description: "Selected workspace disappeared before output")
    }
    let context = try workspaceContext(url.absoluteString)
    let window = try windowId(workspace.window, workspace.pid)
    try require(
      context == workspace.context.split(separator: "/").last.map(String.init)
        && window == nativeWorkspaceScopeWindow,
      "Selected workspace or native window changed before output")
    receipt["workspaceScope"] = ["contextId": context, "windowId": window]
    return (receipt, false)
  } catch {
    return (workspaceScopeFailure(receipt, String(describing: error)), true)
  }
}
func validWorkspaceName(_ value: String) -> Bool {
  !value.isEmpty && value.unicodeScalars.count <= 200
    && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    && !value.unicodeScalars.contains {
      [.control, .format, .surrogate].contains($0.properties.generalCategory)
    }
}
func workspaceContext(_ raw: String) throws -> String {
  guard let url = URLComponents(string: raw), url.scheme == "https", url.host == "app.slack.com",
    url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
    url.string == raw, url.percentEncodedPath == url.path,
    raw.hasPrefix("https://app.slack.com/client/")
  else { throw Failure(description: "Workspace URL is not canonical") }
  let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
  try require(
    parts.count >= 3 && parts[0].isEmpty && parts[1] == "client", "Invalid workspace path")
  let context = String(parts[2])
  try require(
    context.range(of: #"\A[TE][A-Z0-9]{1,63}\z"#, options: .regularExpression) != nil,
    "Workspace context is invalid")
  return context
}
func validWorkspaceDomain(_ value: String) -> Bool {
  value.range(
    of: #"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.enterprise)?\.slack\.com\z"#,
    options: .regularExpression) != nil
}
func validateWorkspaceRows(_ rows: [WorkspaceRow], _ name: String) throws {
  try require(
    !rows.isEmpty && rows.count <= 64, "Workspace selector inventory exceeds bounds or is empty")
  try require(
    rows.allSatisfy {
      validWorkspaceName($0.name) && ($0.domain.map(validWorkspaceDomain) ?? true)
    },
    "Workspace selector name or domain is invalid")
  let domains = rows.compactMap { $0.domain }
  try require(
    domains.isEmpty || domains.count == rows.count,
    "Workspace selector mixes rows with and without domains")
  try require(Set(domains).count == domains.count, "Workspace selector domains are duplicated")
  let current = rows.filter { $0.current }
  try require(
    current.count == 1 && current[0].name == name,
    "Workspace selector current marker disagrees with the loaded workspace")
}
func workspaceMatches(_ rows: [WorkspaceRow], _ requested: String, _ currentContext: String)
  -> [WorkspaceRow]
{
  if requested.hasPrefix("workspace:") {
    return rows.filter { $0.domain.map { "workspace:" + $0 } == requested }
  }
  if requested.range(of: #"\A[TE][A-Z0-9]{1,63}\z"#, options: .regularExpression) != nil {
    return requested == currentContext ? rows.filter { $0.current } : []
  }
  return rows.filter { $0.name == requested }
}
func verifyWorkspaceTransition(
  _ before: WorkspaceView, _ after: WorkspaceView,
  _ rowsBefore: [WorkspaceRow], _ rowsAfter: [WorkspaceRow], _ selected: WorkspaceRow
) throws {
  _ = try workspaceContext(before.url)
  _ = try workspaceContext(after.url)
  try validateWorkspaceRows(rowsBefore, before.name)
  try validateWorkspaceRows(rowsAfter, after.name)
  try require(
    before.windowId > 0 && before.windowId == after.windowId,
    "Workspace window changed during switching")
  try require(
    rowsBefore.filter { $0 == selected }.count == 1, "Selected workspace was not uniquely observed")
  try require(
    rowsBefore.map { [$0.name, $0.domain] } == rowsAfter.map { [$0.name, $0.domain] },
    "Workspace selector inventory changed during switching")
  try require(
    rowsAfter.filter { $0.current }.first.map {
      $0.name == selected.name && $0.domain == selected.domain
    } == true,
    "Workspace destination differs from the exact selected name and domain")
  if selected.current {
    try require(
      before == after && rowsBefore == rowsAfter, "Current workspace changed during a no-op")
  } else {
    try require(
      before.contextId != after.contextId, "Workspace switch did not establish a distinct context")
    let old = rowsBefore.first { $0.current }!
    try require(
      rowsAfter.contains { $0.name == old.name && $0.domain == old.domain && !$0.current },
      "Previous workspace is not verified as inactive")
  }
}
func workspaceChildren(_ element: AXUIElement) throws -> [AXUIElement] {
  guard let values = attr(element, kAXChildrenAttribute) as? [AXUIElement] else {
    throw Failure(description: "Workspace control child inventory is unavailable")
  }
  try require(
    values.count <= 100 && Set(values.map { AXIdentity(element: $0) }).count == values.count,
    "Workspace control children are duplicated or exceed bounds")
  for child in values {
    guard let parent = attr(child, kAXParentAttribute),
      CFGetTypeID(parent) == AXUIElementGetTypeID()
    else {
      throw Failure(description: "Workspace control parent is unavailable")
    }
    try require(CFEqual(parent, element), "Workspace control parent changed")
  }
  return values
}
func workspaceShape(_ element: AXUIElement, _ expectedRole: String, _ expectedClasses: [String])
  throws
{
  try require(
    role(element) == expectedRole && classes(element).count == expectedClasses.count
      && Set(classes(element)) == Set(expectedClasses)
      && attr(element, kAXURLAttribute) == nil
      && (attr(element, kAXEnabledAttribute) as? Bool) == true,
    "Unsupported workspace selector control shape")
}
func workspaceLeaf(_ element: AXUIElement) throws -> String {
  try workspaceShape(element, "AXStaticText", [])
  try require(try workspaceChildren(element).isEmpty, "Workspace text contains nested controls")
  let value = label(element)
  try require(scalarValue(element) == value, "Workspace text value disagrees with its label")
  return value
}
func workspaceGroupLeaf(_ element: AXUIElement, _ expectedClasses: [String]) throws -> String {
  try workspaceShape(element, "AXGroup", expectedClasses)
  let children = try workspaceChildren(element)
  try require(children.count == 1, "Workspace label is missing or duplicated")
  return try workspaceLeaf(children[0])
}
func workspaceChecked(_ classes: [String], _ value: String?) throws -> Bool {
  let base = ["c-button-unstyled", "p-team_switcher_menu__item", "c-menu_item__button"]
  let checked = classes.contains("c-menu_item__button--checked")
  let expected =
    base + (checked ? ["c-menu_item__button--checked"] : [])
    + (classes.contains("c-button--focus-visible") ? ["c-button--focus-visible"] : [])
  try require(
    Set(classes) == Set(expected) && classes.count == expected.count
      && value == (checked ? "1" : "0"), "Workspace current marker is inconsistent")
  return checked
}
// This terminal row is verified only as inventory, never selected.
func workspaceAdditionMatches(
  _ nodeRole: String, _ names: [String], _ name: String, _ value: String?,
  index: Int, count: Int, enabled: Bool, hasURL: Bool
) -> Bool {
  let base = [
    "c-button-unstyled", "p-team_switcher_menu__item", "p-team_switcher_menu__item--add",
    "c-menu_item__button",
  ]
  let expected =
    base + (names.contains("c-button--focus-visible") ? ["c-button--focus-visible"] : [])
  return nodeRole == "AXMenuItem" && enabled && !hasURL
    && names.count == expected.count && Set(names) == Set(expected)
    && (2...65).contains(count) && index == count - 1
    && name == "Add a workspace" && value == ""
}
struct WorkspaceSelector {
  let control: AXUIElement
  let menu: AXUIElement
  let rows: [WorkspaceRow]
  let elements: [AXUIElement]
}
func workspaceView(_ workspace: Workspace) throws -> WorkspaceView {
  let root = try workspace.root()
  let nodes = try tree(root)
  let wrappers = nodes.filter { classes($0.element).contains("p-client_workspace_wrapper") }
  try require(
    wrappers.count == 1 && role(wrappers[0].element) == "AXGroup"
      && classes(wrappers[0].element) == ["p-client_workspace_wrapper"],
    "Current workspace name is unavailable or ambiguous")
  let name = label(wrappers[0].element)
  try require(validWorkspaceName(name), "Current workspace name is invalid")
  guard let url = attr(root, kAXURLAttribute) as? URL else {
    throw Failure(description: "Current workspace URL is unavailable")
  }
  _ = try workspaceContext(url.absoluteString)
  return WorkspaceView(
    url: url.absoluteString, name: name, windowId: try windowId(workspace.window, workspace.pid))
}
// Focus styling may remain after focus moves away. This one observed class is
// cosmetic; workspace identity still comes from the verified wrapper and menu.
func workspaceSwitcherShapeMatches(
  _ nodeRole: String, _ names: [String], enabled: Bool, hasURL: Bool
) -> Bool {
  let base = ["c-button-unstyled", "p-account_switcher"]
  let expected =
    base + (names.contains("c-button--focus-visible") ? ["c-button--focus-visible"] : [])
  return nodeRole == "AXPopUpButton" && enabled && !hasURL
    && names.count == expected.count && Set(names) == Set(expected)
}
func workspaceControl(_ workspace: Workspace) throws -> (AXUIElement, AXUIElement) {
  let root = try workspace.root()
  let controls = try tree(root).filter { classes($0.element).contains("p-account_switcher") }
  try require(controls.count == 1, "Workspace switcher is unavailable or ambiguous")
  let control = controls[0].element
  try require(
    workspaceSwitcherShapeMatches(
      role(control), classes(control), enabled: attr(control, kAXEnabledAttribute) as? Bool == true,
      hasURL: attr(control, kAXURLAttribute) != nil),
    "Unsupported workspace selector control shape")
  guard let raw = attr(control, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID()
  else {
    throw Failure(description: "Workspace switcher owner is unavailable")
  }
  let owner = raw as! AXUIElement
  try workspaceShape(owner, "AXGroup", [])
  guard let railRaw = attr(owner, kAXParentAttribute),
    CFGetTypeID(railRaw) == AXUIElementGetTypeID()
  else {
    throw Failure(description: "Workspace switcher rail is unavailable")
  }
  let rail = railRaw as! AXUIElement
  try require(
    role(rail) == "AXGroup" && classes(rail).contains("p-tab_rail"),
    "Workspace switcher has foreign ancestry")
  guard let wrapperRaw = attr(rail, kAXParentAttribute),
    CFGetTypeID(wrapperRaw) == AXUIElementGetTypeID()
  else {
    throw Failure(description: "Workspace switcher wrapper is unavailable")
  }
  let wrapper = wrapperRaw as! AXUIElement
  try require(
    classes(wrapper) == ["p-client_workspace_wrapper"] && role(wrapper) == "AXGroup",
    "Workspace switcher has foreign wrapper")
  let owned = try workspaceChildren(owner)
  try require(
    owned.contains { CFEqual($0, control) } && owned.count <= 2,
    "Workspace switcher owner contains unsupported controls")
  return (control, owner)
}
struct WorkspaceRail {
  let group: AXUIElement
  let rows: [WorkspaceRow]
  let elements: [AXUIElement]
}
// One rail button: its icon carries the exact name, while the button label may
// append an unread or mention count. Returns nil for any unsupported shape.
func workspaceRailEntry(
  role: String, classes: [String], value: String?, label: String, iconLabels: [String],
  enabled: Bool, hasURL: Bool
) -> (name: String, current: Bool)? {
  guard role == "AXRadioButton", classes.contains("p-team_sidebar__item"), enabled, !hasURL,
    iconLabels.count == 1, validWorkspaceName(iconLabels[0])
  else { return nil }
  let name = iconLabels[0]
  let current = classes.contains("p-team_sidebar__item--active")
  guard value == (current ? "1" : "0") else { return nil }
  let suffix = label.hasPrefix(name + " ") ? String(label.dropFirst(name.count + 1)) : nil
  guard
    label == name
      || suffix?.range(of: #"\A[0-9]{1,6}\+?\z"#, options: .regularExpression) != nil
  else { return nil }
  return (name, current)
}
func workspacePopupPresent(_ workspace: Workspace) throws -> Bool {
  try tree(workspace.root()).contains { classes($0.element).contains("p-account_switcher") }
}
// Slack shows either a pop-up account switcher or a persistent rail of
// workspace buttons. The rail has no domains and is never opened or closed.
func workspaceRail(_ workspace: Workspace) throws -> WorkspaceRail? {
  let groups = try tree(workspace.root()).filter {
    classes($0.element).contains("p-team_sidebar__teams")
  }
  if groups.isEmpty { return nil }
  try require(
    groups.count == 1 && role(groups[0].element) == "AXTabGroup",
    "Workspace rail is ambiguous or unsupported")
  let group = groups[0].element
  var rows: [WorkspaceRow] = []
  var elements: [AXUIElement] = []
  // Other rail children, such as the Add workspaces button, are never targets.
  for child in try workspaceChildren(group)
  where classes(child).contains("p-team_sidebar__item") {
    let icons = try workspaceChildren(child).filter {
      role($0) == "AXImage" && classes($0).contains("c-team_icon")
    }.map(label)
    guard
      let entry = workspaceRailEntry(
        role: role(child), classes: classes(child), value: scalarValue(child),
        label: label(child), iconLabels: icons,
        enabled: (attr(child, kAXEnabledAttribute) as? Bool) == true,
        hasURL: attr(child, kAXURLAttribute) != nil)
    else { throw Failure(description: "Unsupported workspace rail button shape") }
    rows.append(WorkspaceRow(name: entry.name, domain: nil, current: entry.current))
    elements.append(child)
  }
  try validateWorkspaceRows(rows, workspaceView(workspace).name)
  return WorkspaceRail(group: group, rows: rows, elements: elements)
}
func workspaceSelector(_ workspace: Workspace) throws -> WorkspaceSelector? {
  // With only a rail there is no pop-up selector that could be open.
  if !(try workspacePopupPresent(workspace)), try workspaceRail(workspace) != nil { return nil }
  let (control, owner) = try workspaceControl(workspace)
  let peers = try workspaceChildren(owner).filter { !CFEqual($0, control) }
  if peers.isEmpty { return nil }
  try require(peers.count == 1, "Workspace selector popover is ambiguous")
  try workspaceShape(
    peers[0], "AXGroup",
    ["ReactModal__Content", "ReactModal__Content--after-open", "popover", "c-popover__content"])
  let children = try workspaceChildren(peers[0])
  try require(children.count == 1, "Workspace selector menu is missing or ambiguous")
  let menu = children[0]
  try workspaceShape(menu, "AXMenu", ["c-menu__items"])
  let items = try workspaceChildren(menu)
  try require(items.count >= 2 && items.count <= 65, "Workspace selector inventory exceeds bounds")
  var rows: [WorkspaceRow] = []
  var elements: [AXUIElement] = []
  for (index, item) in items.enumerated() {
    let itemClasses = classes(item)
    if itemClasses.contains("p-team_switcher_menu__item--add") {
      try require(
        workspaceAdditionMatches(
          role(item), itemClasses, label(item), scalarValue(item), index: index, count: items.count,
          enabled: attr(item, kAXEnabledAttribute) as? Bool == true,
          hasURL: attr(item, kAXURLAttribute) != nil),
        "Unsupported workspace addition control")
      let body = try workspaceChildren(item)
      try require(body.count == 1, "Unsupported workspace addition structure")
      try workspaceShape(body[0], "AXGroup", ["c-menu_item__label"])
      let text = try workspaceChildren(body[0])
      try require(
        text.count == 1 && (try workspaceGroupLeaf(text[0], [])) == "Add a workspace",
        "Unsupported workspace addition label")
      continue
    }
    let checked = try workspaceChecked(itemClasses, scalarValue(item))
    try workspaceShape(item, "AXMenuItem", itemClasses)
    try require(
      string(item, "AXDOMIdentifier").range(
        of: "\\Amenu-[0-9]+-\(index)\\z", options: .regularExpression) != nil,
      "Workspace row identity is unsupported")
    let body = try workspaceChildren(item)
    try require(body.count == 1, "Workspace row body is missing or duplicated")
    try workspaceShape(
      body[0], "AXGroup", ["p_team-switcher-menu__item__team", "c-menu_item__label"])
    let parts = try workspaceChildren(body[0])
    try require(parts.count == 4, "Workspace row contains unsupported descendants")
    try workspaceShape(
      parts[0], "AXGroup",
      ["p-account_switcher__row_tile_and_unreads"]
        + (checked ? ["p-account_switcher__row--focused_team"] : []))
    let tile = try workspaceChildren(parts[0])
    try require(tile.count <= 1, "Workspace tile contains unsupported content")
    if let badge = tile.first {
      try workspaceShape(badge, "AXGroup", ["p-account_switcher__row_unread_counts"])
      try require(
        try workspaceChildren(badge).isEmpty, "Workspace unread count has unsupported descendants")
    }
    let name = try workspaceGroupLeaf(
      parts[1], ["p-account_switcher__row_name", "p-account_switcher_peeks-card__title"])
    let domain = try workspaceGroupLeaf(
      parts[2], ["p-account_switcher__row_url", "p-account_switcher_peeks-card__subtitle"])
    try require(
      string(parts[1], "AXDOMIdentifier") == "account_switcher__team-name-\(index)"
        && label(item) == name,
      "Workspace name or row identity disagrees")
    try require(
      string(parts[3], "AXDOMIdentifier") == "account_switcher__team-shortcut-\(index)",
      "Workspace shortcut belongs to another row")
    try require(
      try workspaceGroupLeaf(parts[3], ["accountSwitcherRowShortcut__oUmCT"]) == "⌘\(index + 1)",
      "Workspace shortcut shape is unsupported")
    rows.append(WorkspaceRow(name: name, domain: domain, current: checked))
    elements.append(item)
  }
  try require(
    rows.count == items.count - 1, "Workspace selector has no unique terminal addition control")
  try validateWorkspaceRows(rows, workspaceView(workspace).name)
  return WorkspaceSelector(control: control, menu: menu, rows: rows, elements: elements)
}
func workspaceModalState(_ workspace: Workspace, _ owned: AXUIElement?) throws {
  let blockers = try tree(workspace.window).filter {
    ["AXDialog", "AXSheet", "AXMenu"].contains(role($0.element))
      || string($0.element, kAXSubroleAttribute) == "AXDialog"
      || (attr($0.element, "AXModal") as? Bool) == true
  }.map { $0.element }
  try require(
    ownedSurfaceMatches(blockers, owned), "Unowned dialog or menu prevents workspace input")
  try require(
    try queryFields(workspace.root()).isEmpty,
    "Search picker must be closed before workspace navigation")
}
func requireWorkspaceClosePermission(_ allowed: Bool) throws {
  try require(
    allowed,
    "Post-event access is required to close an owned workspace selector; use permissions --request")
}
func openWorkspaceSelector(
  _ workspace: Workspace, _ expected: WorkspaceView, _ deadline: Date,
  beforePress: () -> Void
) throws -> WorkspaceSelector {
  try requireWorkspaceClosePermission(CGPreflightPostEventAccess())
  try require(try workspaceView(workspace) == expected, "Workspace changed before selector opening")
  try require(try workspaceSelector(workspace) == nil, "Workspace selector is already open")
  let (control, _) = try workspaceControl(workspace)
  try sampleDesktop("before-workspace-selector-open")
  try finalWindowInput(
    expected.windowId, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try workspaceModalState(workspace, nil) },
    verifyControl: {
      try require(
        try workspaceView(workspace) == expected, "Workspace changed immediately before opening")
      try require(
        CFEqual(try workspaceControl(workspace).0, control),
        "Workspace switcher changed before opening")
    },
    input: {
      try require(Date() < deadline, "Workspace action deadline reached; input withheld")
      beforePress()
      try press(control)
    })
  while Date() < deadline {
    settle()
    try sampleDesktop("wait-workspace-selector")
    try require(
      try workspaceView(workspace) == expected, "Workspace changed while opening selector")
    if let selector = try workspaceSelector(workspace) { return selector }
  }
  throw Failure(description: "Workspace selector did not appear; no automatic retry")
}
func verifyWorkspaceSelectorClosure(
  _ expected: WorkspaceView, _ observed: WorkspaceView,
  _ expectedRows: [WorkspaceRow], _ observedRows: [WorkspaceRow],
  sameControl: Bool, sameMenu: Bool
) throws {
  try validateWorkspaceRows(expectedRows, expected.name)
  try validateWorkspaceRows(observedRows, observed.name)
  try require(
    expected == observed && expectedRows == observedRows && sameControl && sameMenu,
    "Owned workspace selector changed before close")
}
func workspaceSelectorFocusMatches(
  _ focused: [AXUIElement], control: AXUIElement, menu: AXUIElement, rows: [AXUIElement]
) -> Bool {
  guard focused.count == 1 else { return false }
  return CFEqual(focused[0], control) || CFEqual(focused[0], menu)
    || rows.contains { CFEqual($0, focused[0]) }
}
func postWorkspaceEscape(
  deadline: Date, now: () -> Date = { Date() }, interrupted: () -> Bool,
  preflight: () throws -> Void, down: () -> Void, up: () -> Void,
  wait: () throws -> Void
) throws {
  func ready() throws {
    try require(!interrupted(), "Workspace selector Escape interrupted; input withheld")
    try require(now() < deadline, "Workspace selector close deadline reached; input withheld")
  }
  try ready()
  try preflight()
  try ready()
  // A posted key-down always receives its matching release, even if cancellation
  // or an expired deadline occurs afterward. No second key-down is attempted.
  defer { up() }
  down()
  try wait()
}
func workspaceSelectorEscape(
  _ selector: WorkspaceSelector, _ workspace: Workspace,
  _ expected: WorkspaceView, _ deadline: Date
) throws {
  try sampleDesktop("before-workspace-selector-escape")
  func event(_ type: NSEvent.EventType) -> CGEvent? {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: expected.windowId, context: nil,
      characters: "\u{1B}", charactersIgnoringModifiers: "\u{1B}",
      isARepeat: false, keyCode: 53)?.cgEvent
  }
  guard let down = event(.keyDown), let emergencyUp = event(.keyUp) else {
    throw Failure(description: "Cannot construct workspace selector Escape")
  }
  try postWorkspaceEscape(
    deadline: deadline, interrupted: { interrupted },
    preflight: {
      try finalWindowInput(
        expected.windowId, currentWindow: { try windowId(workspace.window, workspace.pid) },
        noModal: { try workspaceModalState(workspace, selector.menu) },
        verifyControl: {
          guard let fresh = try workspaceSelector(workspace) else {
            throw Failure(description: "Owned workspace selector disappeared")
          }
          try verifyWorkspaceSelectorClosure(
            expected, workspaceView(workspace), selector.rows, fresh.rows,
            sameControl: CFEqual(fresh.control, selector.control),
            sameMenu: CFEqual(fresh.menu, selector.menu))
          let focused = try focusedNodes(workspace.root()).map { $0.element }
          try require(
            workspaceSelectorFocusMatches(
              focused, control: selector.control, menu: selector.menu, rows: selector.elements),
            "Owned workspace selector does not uniquely own focus; Escape withheld")
        },
        input: {
          try requireWorkspaceClosePermission(CGPreflightPostEventAccess())
          try require(
            CGEventSource.flagsState(.combinedSessionState).intersection([
              .maskCommand, .maskControl, .maskAlternate, .maskShift,
            ]).isEmpty && NSEvent.pressedMouseButtons == 0,
            "Physical input held; workspace selector Escape withheld")
          try requireForegroundInput()
        })
    },
    down: { down.postToPid(workspace.pid) },
    up: { (event(.keyUp) ?? emergencyUp).postToPid(workspace.pid) },
    wait: { axPause(until: Date().addingTimeInterval(0.04)) })
  try sampleDesktop("after-workspace-selector-escape")
}
func closeWorkspaceSelector(
  _ selector: WorkspaceSelector, _ workspace: Workspace,
  _ expected: WorkspaceView, _ deadline: Date
) throws {
  // AXCancel and popup AXPress each reported success without closing this menu
  // in live tests. Escape is the sole close strategy, never a chained fallback.
  try workspaceSelectorEscape(selector, workspace, expected, deadline)
  while Date() < deadline {
    settle()
    try sampleDesktop("wait-workspace-selector-close")
    try require(
      try workspaceView(workspace) == expected, "Workspace changed while closing selector")
    if try workspaceSelector(workspace) == nil { return }
  }
  throw Failure(description: "Workspace selector closure is unverified; inspect before retrying")
}
// Listing and switching through the persistent workspace rail. Nothing is
// opened or closed; a switch presses one verified rail button at most once.
func workspaceRailCommand(
  _ operation: String, _ requested: String?, _ workspace: Workspace, _ rail: WorkspaceRail,
  _ before: WorkspaceView, _ deadline: Date, _ result: inout [String: Any],
  beforePress: () -> Void
) throws {
  let rowsBefore = rail.rows
  result["before"] = before.receipt(rowsBefore)
  let matches = requested.map { workspaceMatches(rowsBefore, $0, before.contextId) } ?? []
  if operation == "switch-workspace" {
    if matches.count != 1 {
      result["status"] = matches.isEmpty ? "not-found" : "ambiguous"
      result["error"] = "Exact workspace target unavailable or ambiguous; no workspace selected"
    } else {
      result["selection"] = ["name": matches[0].name, "domain": NSNull()]
    }
  }
  func freshRail(_ target: Workspace) throws -> WorkspaceRail {
    guard let fresh = try workspaceRail(target) else {
      throw Failure(description: "Workspace rail disappeared during observation")
    }
    return fresh
  }
  guard operation == "switch-workspace", matches.count == 1, !matches[0].current else {
    let fresh = try freshRail(workspace)
    try require(
      CFEqual(fresh.group, rail.group) && fresh.rows == rowsBefore,
      "Workspace rail changed during observation")
    let after = try workspaceView(workspace)
    try require(before == after, "Workspace changed during rail observation")
    if operation == "switch-workspace", matches.count == 1 {
      try verifyWorkspaceTransition(before, after, rowsBefore, fresh.rows, matches[0])
    }
    result["after"] = after.receipt(fresh.rows)
    return
  }
  let selected = matches[0]
  let selectedIndex = rowsBefore.firstIndex(of: selected)!
  let element = rail.elements[selectedIndex]
  try sampleDesktop("before-workspace-switch")
  try finalWindowInput(
    before.windowId, currentWindow: { try windowId(workspace.window, workspace.pid) },
    noModal: { try workspaceModalState(workspace, nil) },
    verifyControl: {
      try require(try workspaceView(workspace) == before, "Workspace changed before selection")
      let fresh = try freshRail(workspace)
      try require(
        CFEqual(fresh.group, rail.group) && fresh.rows == rowsBefore
          && CFEqual(fresh.elements[selectedIndex], element),
        "Workspace target changed before selection")
    },
    input: {
      try require(Date() < deadline, "Workspace switch deadline reached; input withheld")
      beforePress()
      try press(element)
    })
  while Date() < deadline {
    settle()
    try sampleDesktop("wait-workspace-switch")
    guard let candidate = try? Workspace(workspace.app, workspace.pid) else { continue }
    try require(
      CFEqual(candidate.window, workspace.window),
      "Workspace switch opened or selected another native window")
    guard let view = try? workspaceView(candidate),
      view.name == selected.name && view.contextId != before.contextId,
      let fresh = try? workspaceRail(candidate)
    else { continue }
    try verifyWorkspaceTransition(before, view, rowsBefore, fresh.rows, selected)
    result["after"] = view.receipt(fresh.rows)
    try require(
      try workspaceView(candidate) == view, "Workspace changed after final verification")
    return
  }
  throw Failure(description: "Workspace switch destination did not verify; do not replay")
}
func workspaceCommand(_ operation: String, _ requested: String?, _ workspace: Workspace) throws
  -> [String: Any]
{
  var rail = false
  var opened = false
  var reused = false
  var verificationOpened = false
  var closed = false
  var attempted = false
  var result: [String: Any] = [
    "operation": operation, "pid": workspace.pid,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
  ]
  if let requested { result["requested"] = requested }
  let deadline = Date().addingTimeInterval(12)
  do {
    if operation == "switch-workspace" {
      try require(requested.map(validWorkspaceName) == true, "Workspace target is invalid")
    }
    let before = try workspaceView(workspace)
    result["before"] = before.receipt()
    if operation == "current-workspace" {
      let after = try workspaceView(workspace)
      try require(before == after, "Current workspace changed during inspection")
      result["after"] = after.receipt()
    } else if !(try workspacePopupPresent(workspace)), let observed = try workspaceRail(workspace) {
      rail = true
      reused = true
      try workspaceModalState(workspace, nil)
      try workspaceRailCommand(
        operation, requested, workspace, observed, before, deadline, &result,
        beforePress: { attempted = true })
    } else {
      var selector: WorkspaceSelector
      if let current = try workspaceSelector(workspace) {
        selector = current
        reused = true
        try workspaceModalState(workspace, current.menu)
      } else {
        selector = try openWorkspaceSelector(
          workspace, before, deadline, beforePress: { opened = true })
      }
      let rowsBefore = selector.rows
      result["before"] = before.receipt(rowsBefore)
      let matches = requested.map { workspaceMatches(rowsBefore, $0, before.contextId) } ?? []
      if operation == "switch-workspace" {
        if matches.count != 1 {
          result["status"] = matches.isEmpty ? "not-found" : "ambiguous"
          result["error"] = "Exact workspace target unavailable or ambiguous; no workspace selected"
        } else {
          result["selection"] = [
            "name": matches[0].name, "domain": matches[0].domain as Any? ?? NSNull(),
          ]
        }
      }
      if operation == "switch-workspace", matches.count == 1, !matches[0].current {
        let selected = matches[0]
        let selectedIndex = rowsBefore.firstIndex(of: selected)!
        let element = selector.elements[selectedIndex]
        try sampleDesktop("before-workspace-switch")
        try finalWindowInput(
          before.windowId, currentWindow: { try windowId(workspace.window, workspace.pid) },
          noModal: { try workspaceModalState(workspace, selector.menu) },
          verifyControl: {
            try require(
              try workspaceView(workspace) == before, "Workspace changed before selection")
            guard let fresh = try workspaceSelector(workspace) else {
              throw Failure(description: "Workspace selector disappeared before selection")
            }
            try require(
              CFEqual(fresh.menu, selector.menu) && fresh.rows == rowsBefore
                && CFEqual(fresh.elements[selectedIndex], element),
              "Workspace target changed before selection")
          },
          input: {
            try require(Date() < deadline, "Workspace switch deadline reached; input withheld")
            try requireWorkspaceClosePermission(CGPreflightPostEventAccess())
            attempted = true
            try press(element)
          })
        var destination: Workspace?
        var after: WorkspaceView?
        while Date() < deadline {
          settle()
          try sampleDesktop("wait-workspace-switch")
          if let candidate = try? Workspace(workspace.app, workspace.pid) {
            try require(
              CFEqual(candidate.window, workspace.window),
              "Workspace switch opened or selected another native window")
            if let view = try? workspaceView(candidate),
              view.name == selected.name && view.contextId != before.contextId
            {
              destination = candidate
              after = view
              break
            }
          }
        }
        guard let destination, let after else {
          throw Failure(description: "Workspace switch destination did not verify; do not replay")
        }
        selector = try openWorkspaceSelector(
          destination, after, deadline, beforePress: { verificationOpened = true })
        try verifyWorkspaceTransition(before, after, rowsBefore, selector.rows, selected)
        result["after"] = after.receipt(selector.rows)
        try closeWorkspaceSelector(selector, destination, after, deadline)
        closed = true
        try require(
          try workspaceView(destination) == after, "Workspace changed after final verification")
      } else {
        guard let fresh = try workspaceSelector(workspace) else {
          throw Failure(description: "Workspace selector disappeared during observation")
        }
        try require(
          CFEqual(fresh.menu, selector.menu) && fresh.rows == rowsBefore,
          "Workspace selector changed during observation")
        let after = try workspaceView(workspace)
        try require(before == after, "Workspace changed during selector observation")
        if operation == "switch-workspace", matches.count == 1 {
          try verifyWorkspaceTransition(before, after, rowsBefore, fresh.rows, matches[0])
        }
        result["after"] = after.receipt(fresh.rows)
        if opened {
          try closeWorkspaceSelector(fresh, workspace, after, deadline)
          closed = true
        }
        try require(try workspaceView(workspace) == after, "Workspace changed after inspection")
      }
    }
    if result["status"] == nil { result["status"] = "ok" }
    try sampleDesktop("workspace-finish")
  } catch {
    result["status"] = "stopped"
    result["error"] = String(describing: error)
    result["next"] =
      "Inspect the current workspace and selector before another request; do not replay an uncertain switch."
    if let observation = afterErrorObservation() { result["observation"] = observation }
  }
  result["switchAttempted"] = attempted
  result["workspaceSwitchMayHaveBeenRequested"] = attempted
  var selectorEvidence: [String: Any] = [
    "opened": opened, "reused": reused, "verificationOpened": verificationOpened, "closed": closed,
  ]
  if rail { selectorEvidence["layout"] = "rail" }
  result["selector"] = selectorEvidence
  result["desktop"] = [
    "samples": desktopSamples, "scope": "bounded desktop samples, not continuous proof",
  ]
  return result
}
