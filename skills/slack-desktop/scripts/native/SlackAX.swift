import AppKit
import ApplicationServices
import Darwin

struct Failure: Error, CustomStringConvertible { let description: String }
func require(_ ok: Bool, _ message: String) throws {
  if !ok { throw Failure(description: message) }
}
func axErrorName(_ result: AXError) -> String {
  switch result {
  case .success: return "success"
  case .apiDisabled: return "api-disabled"
  case .cannotComplete: return "cannot-complete"
  case .invalidUIElement: return "invalid-ui-element"
  case .attributeUnsupported: return "attribute-unsupported"
  case .actionUnsupported: return "action-unsupported"
  case .noValue: return "no-value"
  case .illegalArgument: return "illegal-argument"
  case .failure: return "failure"
  case .notImplemented: return "not-implemented"
  default: return "unknown"
  }
}
// Opt-in read accounting. SLACK_AX_PROFILE=1 prints one stderr line at exit with
// counts only: no labels, values or identifiers.
final class AXProfile {
  static let shared: AXProfile? =
    ["1", "sites"].contains(ProcessInfo.processInfo.environment["SLACK_AX_PROFILE"] ?? "")
    ? AXProfile() : nil
  // SLACK_AX_PROFILE=sites adds one line per tree() call site: walks and nodes visited.
  private let listSites = ProcessInfo.processInfo.environment["SLACK_AX_PROFILE"] == "sites"
  private var sites: [String: (walks: Int, nodes: Int)] = [:]
  func walk(_ site: String, nodes: Int) {
    counts["walk", default: 0] += 1
    let previous = sites[site] ?? (0, 0)
    sites[site] = (previous.walks + 1, previous.nodes + nodes)
  }
  private let started = Date()
  private var counts: [String: Int] = [:]
  private var seconds: [String: TimeInterval] = [:]
  private init() {
    atexit { AXProfile.shared?.report() }
  }
  func record(_ kind: String, since start: Date) {
    counts[kind, default: 0] += 1
    seconds[kind, default: 0] += Date().timeIntervalSince(start)
  }
  func count(_ kind: String) { counts[kind, default: 0] += 1 }
  private func report() {
    let parts = counts.keys.sorted().map { key -> String in
      guard let spent = seconds[key] else { return "\(key)=\(counts[key] ?? 0)" }
      return "\(key)=\(counts[key] ?? 0)/\(Int(spent * 1000))ms"
    }
    let line =
      "ax-profile total=\(Int(Date().timeIntervalSince(started) * 1000))ms "
      + parts.joined(separator: " ") + "\n"
    FileHandle.standardError.write(Data(line.utf8))
    guard listSites else { return }
    for (site, total) in sites.sorted(by: { $0.value.nodes > $1.value.nodes }) {
      FileHandle.standardError.write(
        Data("ax-walk \(site) walks=\(total.walks) nodes=\(total.nodes)\n".utf8))
    }
  }
}
// Always one live round trip to Slack; never served from the walk memo.
func liveAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  let started = AXProfile.shared.map { _ in Date() }
  defer { if let started { AXProfile.shared?.record("read", since: started) } }
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}
// Several attributes of one element in a single live round trip. An attribute
// Slack does not supply is nil, exactly as a failed single read. If the batched
// call itself fails, each attribute is read individually.
func liveAttrs(_ element: AXUIElement, _ names: [String]) -> [CFTypeRef?] {
  let started = AXProfile.shared.map { _ in Date() }
  var raw: CFArray?
  let result = AXUIElementCopyMultipleAttributeValues(
    element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
  if let started { AXProfile.shared?.record("batch", since: started) }
  guard result == .success, let values = raw as? [AnyObject], values.count == names.count else {
    return names.map { liveAttr(element, $0) }
  }
  return values.map { value -> CFTypeRef? in
    if value is NSNull { return nil }
    if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
      return nil
    }
    return value
  }
}
// A tree walk reads these with each node's children, so the filter that follows
// a walk needs no further round trips. Entries are what the walk itself read:
// they expire quickly and are dropped before any action, input or wait, and
// structure (AXChildren) is never served from here.
let walkMemoNames = [kAXRoleAttribute as String, "AXDOMClassList", "AXDOMIdentifier"]
let walkReadNames = [kAXChildrenAttribute as String] + walkMemoNames
enum AXWalkMemo {
  static let lifetime: TimeInterval = 0.2
  private static var entries: [AXIdentity: (at: TimeInterval, values: [CFTypeRef?])] = [:]
  static func store(_ element: AXUIElement, _ values: [CFTypeRef?]) {
    if entries.count >= 20_000 { entries.removeAll(keepingCapacity: true) }
    entries[AXIdentity(element: element)] = (ProcessInfo.processInfo.systemUptime, values)
  }
  static func value(
    _ element: AXUIElement, _ name: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) -> CFTypeRef?? {
    guard let slot = walkMemoNames.firstIndex(of: name), !entries.isEmpty,
      let entry = entries[AXIdentity(element: element)], now - entry.at < lifetime
    else { return nil }
    return .some(entry.values[slot])
  }
  // The workspace client last proven to be the only ready one, for the same
  // quiet interval: any action, input or wait forgets it.
  private static var client: (app: AXUIElement, element: AXUIElement, at: TimeInterval)?
  static func rememberClient(_ element: AXUIElement, in app: AXUIElement) {
    client = (app, element, ProcessInfo.processInfo.systemUptime)
  }
  static func provenClient(
    in app: AXUIElement, now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) -> AXUIElement? {
    guard let client, CFEqual(client.app, app), now - client.at < lifetime else { return nil }
    return client.element
  }
  static func invalidate() {
    entries.removeAll(keepingCapacity: true)
    client = nil
  }
}
// Every wait goes through here: Slack may change while the helper is idle.
func axPause(until date: Date) {
  AXWalkMemo.invalidate()
  RunLoop.current.run(until: date)
  AXWalkMemo.invalidate()
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  if let remembered = AXWalkMemo.value(element, name) {
    AXProfile.shared?.count("memo")
    return remembered
  }
  return liveAttr(element, name)
}
func string(_ element: AXUIElement, _ name: String) -> String {
  attr(element, name) as? String ?? ""
}
func role(_ element: AXUIElement) -> String { string(element, kAXRoleAttribute) }
func label(_ element: AXUIElement) -> String {
  [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].map { string(element, $0) }.first
  { !$0.isEmpty } ?? ""
}
struct Node {
  let element: AXUIElement
  let depth: Int
  // Index, in the same tree() result, of the node this one was first reached
  // from; -1 for the walk root or a node not produced by tree().
  var parent: Int = -1
}
// AXChildren is a graph: aliases and back-edges must not multiply work or
// fabricate multiple windows. Keep native identities alive for each traversal.
struct AXIdentity: Hashable {
  let element: AXUIElement
  static func == (lhs: AXIdentity, rhs: AXIdentity) -> Bool { CFEqual(lhs.element, rhs.element) }
  func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}
final class AXIdentitySet {
  private var identities = Set<AXIdentity>()
  private(set) var repeatedReferences = 0
  var count: Int { identities.count }
  func contains(_ element: AXUIElement) -> Bool {
    identities.contains(AXIdentity(element: element))
  }
  @discardableResult func insert(_ element: AXUIElement) -> Bool {
    let inserted = identities.insert(AXIdentity(element: element)).inserted
    if !inserted { repeatedReferences += 1 }
    return inserted
  }
}
func mergeAXChildren(_ children: [AXUIElement], windows: [AXUIElement]) -> [AXUIElement] {
  let seen = AXIdentitySet()
  for child in children { seen.insert(child) }
  return children + windows.filter { seen.insert($0) }
}
func accessibilityChildren(_ element: AXUIElement) -> [AXUIElement] {
  let values = liveAttrs(element, walkReadNames)
  AXWalkMemo.store(element, Array(values.dropFirst()))
  return mergedChildren(element, children: values[0], role: values[1])
}
func mergedChildren(_ element: AXUIElement, children: CFTypeRef?, role: CFTypeRef?)
  -> [AXUIElement]
{
  let children = children as? [AXUIElement] ?? []
  guard role as? String == "AXApplication" else { return children }
  // Consult the explicit window inventory if the child list omits a window.
  // This reads existing windows; it never opens or raises one.
  return mergeAXChildren(
    children, windows: liveAttr(element, kAXWindowsAttribute) as? [AXUIElement] ?? [])
}
func tree(
  _ root: AXUIElement, children: (AXUIElement) -> [AXUIElement] = accessibilityChildren,
  now: () -> Date = { Date() }, maxNodes: Int = 5000, maxDepth: Int = 40, budget: TimeInterval = 8,
  file: String = #fileID, line: Int = #line
) throws -> [Node] {
  var result: [Node] = []
  defer { AXProfile.shared?.walk("\(file):\(line)", nodes: result.count) }
  let deadline = now().addingTimeInterval(budget)
  let seen = AXIdentitySet()
  seen.insert(root)
  var queue = [Node(element: root, depth: 0)]
  var cursor = 0
  while cursor < queue.count {
    try require(
      now() < deadline && result.count < maxNodes,
      "Accessibility traversal exceeded bounds; narrow the visible UI and retry")
    let node = queue[cursor]
    cursor += 1
    result.append(node)
    for child in children(node.element) {
      try require(
        now() < deadline, "Accessibility traversal deadline reached; inspect state before retrying")
      if !seen.insert(child) { continue }
      try require(
        queue.count < maxNodes && node.depth < maxDepth,
        "Accessibility traversal exceeded bounds; narrow the visible UI and retry")
      queue.append(Node(element: child, depth: node.depth + 1, parent: cursor - 1))
    }
    try require(
      now() < deadline,
      "Accessibility traversal deadline reached; inspect state before retrying")
  }
  return result
}
func snapshot(_ app: AXUIElement) throws -> [String: Any] {
  let nodes = try tree(app)
  return [
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "scope": "currently exposed accessibility tree; not complete channel history",
    "nodes": nodes.compactMap { node -> [String: Any]? in
      let values = liveAttrs(
        node.element,
        [
          kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
          kAXURLAttribute,
        ])
      let value = values[3] as? String ?? ""
      let name =
        [values[1] as? String ?? "", values[2] as? String ?? "", value].first { !$0.isEmpty } ?? ""
      guard !name.isEmpty else { return nil }
      var record: [String: Any] = [
        "role": values[0] as? String ?? "", "label": name, "depth": node.depth,
      ]
      if let url = values[4] as? URL { record["url"] = url.absoluteString }
      if !value.isEmpty && value != name { record["value"] = value }
      return record
    },
  ]
}
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return names as? [String] ?? []
}
func geometry(_ element: AXUIElement) throws -> CGRect {
  guard let p = attr(element, kAXPositionAttribute), let s = attr(element, kAXSizeAttribute),
    CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
  else {
    throw Failure(description: "Window geometry unavailable")
  }
  var point = CGPoint.zero
  var size = CGSize.zero
  try require(
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
      && AXValueGetValue(s as! AXValue, .cgSize, &size), "Invalid window geometry")
  return CGRect(origin: point, size: size)
}
func windowId(_ window: AXUIElement, _ pid: pid_t) throws -> Int {
  let rect = try geometry(window)
  let rows =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  let ids = rows.filter { row in
    guard (row[kCGWindowOwnerPID as String] as? Int32) == pid,
      (row[kCGWindowLayer as String] as? Int) == 0,
      let raw = row[kCGWindowBounds as String] as? [String: Any],
      let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary)
    else { return false }
    return bounds == rect
  }.compactMap { $0[kCGWindowNumber as String] as? Int }
  try require(ids.count == 1, "Cannot uniquely match Slack window; no input posted")
  return ids[0]
}
func classes(_ element: AXUIElement) -> [String] {
  attr(element, "AXDOMClassList") as? [String] ?? []
}
func identity(_ root: AXUIElement) -> [String: Any] {
  [
    "title": label(root),
    "url": (attr(root, kAXURLAttribute) as? URL)?.absoluteString as Any? ?? NSNull(),
  ]
}
let searchScopeRoles = Set([
  "AXButton", "AXPopUpButton", "AXCheckBox", "AXComboBox", "AXRadioButton",
])
func scalarValue(_ element: AXUIElement) -> String? {
  let value = attr(element, kAXValueAttribute)
  if let value = value as? String { return value }
  if let value = value as? NSNumber { return value.stringValue }
  return nil
}
// Conflict diagnostics deliberately exclude labels, values, URLs and message content.
struct CaptureAXDescriptor {
  let role: String
  let id: String
  let classes: [String]
  let clipped: [String]
  init(_ row: [String: Any]) {
    func bounded(_ value: String, _ limit: Int) -> String {
      String(value.unicodeScalars.prefix(limit))
    }
    let rawRole = row["role"] as? String ?? ""
    let rawID = row["id"] as? String ?? ""
    let rawClasses = row["classes"] as? [String] ?? []
    role = bounded(rawRole, 64)
    id = bounded(rawID, 200)
    classes = rawClasses.prefix(12).map { bounded($0, 96) }
    var limits: [String] = []
    if role != rawRole { limits.append("role") }
    if id != rawID { limits.append("id") }
    if classes != rawClasses { limits.append("classes") }
    clipped = limits
  }
  var receipt: [String: Any] {
    var value: [String: Any] = ["role": role, "id": id, "classes": classes]
    if !clipped.isEmpty { value["clipped"] = clipped }
    return value
  }
}
func captureAXDescriptor(_ element: AXUIElement) -> CaptureAXDescriptor {
  CaptureAXDescriptor([
    "role": role(element), "id": string(element, "AXDOMIdentifier"),
    "classes": classes(element),
  ])
}
func captureParentMatches(_ available: Bool, first: Bool, current: Bool) -> [String: Any] {
  guard available else {
    return ["matchesFirst": NSNull(), "matchesCurrent": NSNull(), "matchesNeither": NSNull()]
  }
  return ["matchesFirst": first, "matchesCurrent": current, "matchesNeither": !first && !current]
}
func captureStoredAncestry(_ rows: [[String: Any]], from start: Int?) -> [String: Any] {
  var ancestors: [[String: Any]] = []
  var seen = Set<Int>()
  var current = start
  var stopReason = "root"
  while let index = current {
    guard ancestors.count < 8 else {
      stopReason = "limit"
      break
    }
    guard rows.indices.contains(index) else {
      stopReason = "invalid-index"
      break
    }
    guard seen.insert(index).inserted else {
      stopReason = "cycle"
      break
    }
    let row = rows[index]
    var ancestor: [String: Any] = ["index": index, "node": CaptureAXDescriptor(row).receipt]
    if row["parent"] is NSNull {
      ancestor["parent"] = NSNull()
      current = nil
    } else if let parent = row["parent"] as? Int {
      ancestor["parent"] = parent
      current = parent
    } else {
      stopReason = "invalid-parent"
      ancestors.append(ancestor)
      break
    }
    ancestors.append(ancestor)
  }
  return ["ancestors": ancestors, "truncated": stopReason != "root", "stopReason": stopReason]
}
struct CaptureAncestryConflict {
  let node: CaptureAXDescriptor
  let firstParentIndex: Int?
  let firstParent: CaptureAXDescriptor?
  let firstParentAncestry: [String: Any]
  let currentParentIndex: Int?
  let currentParent: CaptureAXDescriptor?
  let currentParentAncestry: [String: Any]
  let actualParent: [String: Any]
  var tableHeader: [String: Any]? = nil
  var receipt: [String: Any] {
    var value: [String: Any] = [
      "kind": "ambiguous-ancestry", "node": node.receipt,
      "firstParent": [
        "index": firstParentIndex as Any? ?? NSNull(),
        "node": firstParent?.receipt as Any? ?? NSNull(),
        "ancestry": firstParentAncestry,
      ],
      "currentParent": [
        "index": currentParentIndex as Any? ?? NSNull(),
        "node": currentParent?.receipt as Any? ?? NSNull(),
        "ancestry": currentParentAncestry,
      ],
      "actualParent": actualParent,
    ]
    if let tableHeader { value["tableHeader"] = tableHeader }
    return value
  }
}
var firstCaptureConflict: CaptureAncestryConflict?
func canonicalTableCellProjection(
  _ rows: [[String: Any]], cell: Int?, firstParent: Int?, currentParent: Int?,
  liveRole: (Int) throws -> String, parentMatches: (Int, Int) throws -> Bool,
  headerProof: ((Int, Int, Int) throws -> Bool)? = nil
) throws -> Bool {
  let alternateRole = headerProof == nil ? "AXColumn" : "AXGroup"
  guard let cell, let row = firstParent, let column = currentParent,
    [cell, row, column].allSatisfy({ rows.indices.contains($0) }),
    rows[cell]["role"] as? String == "AXCell", rows[cell]["parent"] as? Int == row,
    rows[row]["role"] as? String == "AXRow", rows[column]["role"] as? String == alternateRole,
    let table = rows[row]["parent"] as? Int, rows.indices.contains(table),
    rows[column]["parent"] as? Int == table, rows[table]["role"] as? String == "AXTable",
    Set([cell, row, column, table]).count == 4
  else { return false }
  for (index, expected) in [
    (cell, "AXCell"), (row, "AXRow"), (column, alternateRole), (table, "AXTable"),
  ] {
    guard try liveRole(index) == expected else { return false }
  }
  guard try parentMatches(cell, row) && parentMatches(row, table) && parentMatches(column, table)
  else { return false }
  return try headerProof?(table, column, cell) ?? true
}
func tableHeaderEvidence(
  headerResult: AXError, header: CFTypeRef?, cellsResult: AXError, cells: CFTypeRef?,
  expectedHeader: AXUIElement, cell: AXUIElement
) -> (accepted: Bool, receipt: [String: Any]) {
  var headerReceipt: [String: Any] = ["status": "unavailable", "matchesCurrent": NSNull()]
  var cellsReceipt: [String: Any] = [
    "status": "unavailable", "containsCellExactlyOnce": NSNull(), "matchingCellCount": NSNull(),
  ]
  var matchesHeader = false
  var cellOnce = false
  if headerResult != .success {
    headerReceipt["error"] = ["code": headerResult.rawValue, "name": axErrorName(headerResult)]
  } else if let header {
    if CFGetTypeID(header) == AXUIElementGetTypeID() {
      matchesHeader = CFEqual(header, expectedHeader)
      headerReceipt["status"] = "element"
      headerReceipt["matchesCurrent"] = matchesHeader
    } else {
      headerReceipt["status"] = "invalid-value"
    }
  }
  if cellsResult != .success {
    cellsReceipt["error"] = ["code": cellsResult.rawValue, "name": axErrorName(cellsResult)]
  } else if let cells {
    if CFGetTypeID(cells) == CFArrayGetTypeID(), let entries = cells as? [AnyObject],
      entries.count <= 5000, entries.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() })
    {
      let count = entries.filter { CFEqual($0, cell) }.count
      cellOnce = count == 1
      cellsReceipt["status"] = "array"
      cellsReceipt["matchingCellCount"] = count
      cellsReceipt["containsCellExactlyOnce"] = cellOnce
    } else {
      cellsReceipt["status"] = "invalid-value"
    }
  }
  return (matchesHeader && cellOnce, ["header": headerReceipt, "columnHeaders": cellsReceipt])
}
func captureParentEquals(_ element: AXUIElement, _ expected: AXUIElement) -> Bool {
  guard let parent = liveAttr(element, kAXParentAttribute),
    CFGetTypeID(parent) == AXUIElementGetTypeID()
  else { return false }
  return CFEqual(parent, expected)
}
// Everything a structured capture needs from one node, read live in one round trip.
let captureReadNames: [String] = [
  kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
  kAXHelpAttribute, "AXDOMIdentifier", "AXDOMClassList", kAXURLAttribute, kAXSelectedAttribute,
  kAXExpandedAttribute, kAXChildrenAttribute,
]
struct CaptureRead {
  let element: AXUIElement
  let values: [CFTypeRef?]
  init(_ element: AXUIElement) {
    self.element = element
    values = liveAttrs(element, captureReadNames)
  }
  var role: String { values[0] as? String ?? "" }
  var children: [AXUIElement] {
    mergedChildren(element, children: values[10], role: values[0])
  }
  func row(_ index: Int, _ parent: Int?) -> [String: Any] {
    func text(_ slot: Int) -> String { values[slot] as? String ?? "" }
    var row: [String: Any] = [
      "index": index, "parent": parent as Any? ?? NSNull(), "role": role,
      "label": [text(1), text(2), text(3)].first { !$0.isEmpty } ?? "", "id": text(5),
      "classes": values[6] as? [String] ?? [],
      "AXTitle": text(1), "AXDescription": text(2), "AXValue": text(3), "AXHelp": text(4),
    ]
    if searchScopeRoles.contains(role) {
      let scalar = values[3] as? String ?? (values[3] as? NSNumber)?.stringValue
      row["stateValue"] = scalar as Any? ?? NSNull()
      row["selected"] = (values[8] as? Bool) as Any? ?? NSNull()
    }
    if role == "AXTextField" { row["stateValue"] = (values[3] as? String) as Any? ?? NSNull() }
    if role == "AXRow" { row["expanded"] = (values[9] as? Bool) as Any? ?? NSNull() }
    if let url = values[7] as? URL { row["url"] = url.absoluteString }
    return row
  }
}
// contentSnapshot arms this for the node it is visiting, so that node's role,
// row and children come from one read. It is disarmed before any other node is
// touched; a read outside that window is always a new live read.
var armedCaptureRead: CaptureRead?
func captureRead(_ element: AXUIElement) -> CaptureRead {
  if let armed = armedCaptureRead, CFEqual(armed.element, element) { return armed }
  return CaptureRead(element)
}
func captureLiveRole(_ element: AXUIElement) -> String {
  if let armed = armedCaptureRead, CFEqual(armed.element, element) { return armed.role }
  return liveAttr(element, kAXRoleAttribute) as? String ?? ""
}
func captureChildren(_ element: AXUIElement) -> [AXUIElement] {
  if let armed = armedCaptureRead, CFEqual(armed.element, element) { return armed.children }
  return mergedChildren(
    element, children: liveAttr(element, kAXChildrenAttribute),
    role: liveAttr(element, kAXRoleAttribute))
}
func captureContentRow(_ element: AXUIElement, _ index: Int, _ parent: Int?) -> [String: Any] {
  captureRead(element).row(index, parent)
}
// Preserve ancestry and AX child order. Structured output never needs composer values.
func contentSnapshot(
  _ root: AXUIElement, onNode: ((Int, AXUIElement) -> Void)? = nil,
  readRow: (AXUIElement, Int, Int?) -> [String: Any] = captureContentRow,
  children: (AXUIElement) -> [AXUIElement] = captureChildren,
  liveRole: (AXUIElement) -> String = captureLiveRole,
  parentMatches: (AXUIElement, AXUIElement) -> Bool = captureParentEquals
) throws -> [String: Any] {
  AXProfile.shared?.count("capture")
  let deadline = Date().addingTimeInterval(8)
  var rows: [[String: Any]] = []
  var capturedElements: [AXUIElement] = []
  var firstRows: [AXIdentity: Int] = [:]
  let seen = AXIdentitySet()
  var path = Set<AXIdentity>()
  var firstParents: [AXIdentity: Int] = [:]
  var tableCellProjections = 0
  var tableHeaderProjections = 0
  func visit(_ element: AXUIElement, _ parent: Int?, _ depth: Int) throws {
    try require(
      Date() < deadline, "Structured capture deadline reached; no partial messages returned")
    let key = AXIdentity(element: element)
    if !seen.insert(element) {
      if !path.contains(key) && firstParents[key] != (parent ?? -1) {
        let first = firstParents[key].flatMap { $0 >= 0 ? $0 : nil }
        func fresh<T>(_ read: () -> T) throws -> T {
          try require(
            Date() < deadline, "Structured capture deadline reached; no partial messages returned")
          let value = read()
          try require(
            Date() < deadline, "Structured capture deadline reached; no partial messages returned")
          return value
        }
        if try canonicalTableCellProjection(
          rows, cell: firstRows[key], firstParent: first, currentParent: parent,
          liveRole: { index in try fresh { liveRole(capturedElements[index]) } },
          parentMatches: { index, expected in
            try fresh { parentMatches(capturedElements[index], capturedElements[expected]) }
          })
        {
          tableCellProjections += 1
          return
        }
        var tableHeader: [String: Any]?
        if try canonicalTableCellProjection(
          rows, cell: firstRows[key], firstParent: first, currentParent: parent,
          liveRole: { index in try fresh { liveRole(capturedElements[index]) } },
          parentMatches: { index, expected in
            try fresh { parentMatches(capturedElements[index], capturedElements[expected]) }
          },
          headerProof: { table, header, cell in
            var rawHeader: CFTypeRef?
            let headerResult = try fresh {
              AXUIElementCopyAttributeValue(
                capturedElements[table], "AXHeader" as CFString, &rawHeader)
            }
            var rawCells: CFTypeRef?
            let cellsResult = try fresh {
              AXUIElementCopyAttributeValue(
                capturedElements[table], "AXColumnHeaderUIElements" as CFString, &rawCells)
            }
            let evidence = tableHeaderEvidence(
              headerResult: headerResult, header: rawHeader, cellsResult: cellsResult,
              cells: rawCells,
              expectedHeader: capturedElements[header], cell: capturedElements[cell])
            tableHeader = evidence.receipt
            return evidence.accepted
          })
        {
          tableCellProjections += 1
          tableHeaderProjections += 1
          return
        }
        if firstCaptureConflict == nil {
          func descriptor(_ index: Int?) -> CaptureAXDescriptor? {
            index.map { CaptureAXDescriptor(rows[$0]) }
          }
          var actual: CFTypeRef?
          let result = AXUIElementCopyAttributeValue(
            element, kAXParentAttribute as CFString, &actual)
          let available =
            result == .success
            && actual.map {
              CFGetTypeID($0) == AXUIElementGetTypeID()
            } == true
          var actualReceipt = captureParentMatches(false, first: false, current: false)
          actualReceipt["status"] =
            result == .success && actual != nil ? "invalid-value" : "unavailable"
          if available, let actual {
            let actualElement = actual as! AXUIElement
            actualReceipt = captureParentMatches(
              true, first: first.map { CFEqual(actualElement, capturedElements[$0]) } ?? false,
              current: parent.map { CFEqual(actualElement, capturedElements[$0]) } ?? false)
            actualReceipt["status"] = "element"
            actualReceipt["node"] = captureAXDescriptor(actualElement).receipt
          } else if result != .success {
            actualReceipt["error"] = ["code": result.rawValue, "name": axErrorName(result)]
          }
          firstCaptureConflict = CaptureAncestryConflict(
            node: firstRows[key].map { CaptureAXDescriptor(rows[$0]) }
              ?? captureAXDescriptor(element),
            firstParentIndex: first, firstParent: descriptor(first),
            firstParentAncestry: captureStoredAncestry(rows, from: first),
            currentParentIndex: parent, currentParent: descriptor(parent),
            currentParentAncestry: captureStoredAncestry(rows, from: parent),
            actualParent: actualReceipt, tableHeader: tableHeader)
        }
        throw Failure(
          description:
            "Structured capture has ambiguous accessibility ancestry; no partial messages returned")
      }
      return
    }
    try require(
      Date() < deadline && rows.count < 5000 && depth <= 40,
      "Structured capture exceeded bounds; no partial messages returned")
    firstParents[key] = parent ?? -1
    armedCaptureRead = CaptureRead(element)
    defer { armedCaptureRead = nil }
    if liveRole(element) == "AXTextArea" { return }
    path.insert(key)
    defer { path.remove(key) }
    let index = rows.count
    rows.append(readRow(element, index, parent))
    capturedElements.append(element)
    firstRows[key] = index
    let ownChildren = children(element)
    armedCaptureRead = nil
    onNode?(index, element)
    for child in ownChildren {
      try visit(child, index, depth + 1)
    }
    try require(
      Date() < deadline, "Structured capture deadline reached; no partial messages returned")
  }
  try visit(root, nil, 0)
  return [
    "observedAt": ISO8601DateFormatter().string(from: Date()), "nodes": rows, "truncated": false,
    "repeatedReferences": seen.repeatedReferences, "tableCellProjections": tableCellProjections,
    "tableHeaderProjections": tableHeaderProjections,
  ]
}
