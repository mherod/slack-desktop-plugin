import AppKit
import ApplicationServices
import Darwin

struct UIOptions {
  let filter: String
  let limit: Int
  let depth: Int
  let prepare: Bool
  init(_ arguments: [String]) throws {
    var filter = ""
    var limit = 80
    var depth = 20
    var prepare = false
    var seen = Set<String>()
    try require(arguments.contains("--ui"), "UI options require inspect --ui")
    for argument in arguments {
      guard let first = argument.split(separator: "=", maxSplits: 1).first else {
        throw Failure(description: "UI options cannot be empty")
      }
      let key = String(first)
      try require(seen.insert(key).inserted, "Specify \(key) only once")
      switch key {
      case "--ui": try require(argument == key, "--ui does not accept a value")
      case "--prepare":
        try require(argument == key, "--prepare does not accept a value")
        prepare = true
      case "--filter":
        try require(argument.hasPrefix("--filter="), "Use --filter=TEXT")
        filter = String(argument.dropFirst(9))
        try require(
          filter.unicodeScalars.count <= 200
            && !filter.unicodeScalars.contains {
              $0.value < 32 || (127...159).contains($0.value)
            }, "UI filter must contain at most 200 characters and no control characters")
      case "--limit", "--depth":
        let prefix = key + "="
        try require(argument.hasPrefix(prefix), "Use \(prefix)INTEGER")
        let raw = String(argument.dropFirst(prefix.count))
        try require(
          raw.range(of: #"^(?:0|[1-9][0-9]*)$"#, options: .regularExpression) != nil,
          "UI bounds require canonical nonnegative integers")
        guard let value = Int(raw) else { throw Failure(description: "UI bound is too large") }
        if key == "--limit" {
          try require((1...500).contains(value), "UI limit must be from 1 to 500")
          limit = value
        } else {
          try require((0...40).contains(value), "UI depth must be from 0 to 40")
          depth = value
        }
      default: throw Failure(description: "Unsupported inspect UI option: \(key)")
      }
    }
    self.filter = filter
    self.limit = limit
    self.depth = depth
    self.prepare = prepare
  }
}
func uiRedaction(_ role: String, _ subrole: String, _ classes: [String]) -> String? {
  if role == "AXSecureTextField" || subrole == "AXSecureTextField" { return "secure-content" }
  if role == "AXTextArea" { return "editable-content" }
  let prefixes = [
    "p-message_input", "p-workspace__input", "p-composer", "c-texty_input", "c-wysiwyg",
    "p-texty_sticky_formatting_bar",
  ]
  if classes.contains(where: { value in
    value == "ql-editor" || value == "ql-container" || prefixes.contains(where: value.hasPrefix)
  }) {
    return "composer-content"
  }
  return nil
}
func uiObservedRedaction(_ role: String, _ subrole: String, _ classes: [String], failedReads: Int)
  -> String?
{
  if role.isEmpty || failedReads > 0 { return "unreadable-content" }
  return uiRedaction(role, subrole, classes)
}
func uiSafeChildren<T>(_ redaction: String?, read: () -> [T]) -> [T] {
  guard redaction == nil else { return [] }
  return read()
}
func uiContentPolicy(_ role: String, _ classes: [String]) -> String? {
  if role == "AXList"
    || classes.contains(where: {
      ["p-view_contents", "p-client_workspace_wrapper", "p-client_workspace__tabpanel"].contains($0)
    })
  {
    return "aggregate-value"
  }
  if [
    "AXApplication", "AXWindow", "AXGroup", "AXWebArea", "AXScrollArea", "AXRow", "AXToolbar",
    "AXSplitGroup",
  ].contains(role) {
    return "aggregate-content"
  }
  return nil
}
func uiSafeLabel(_ redaction: String?, _ policy: String?, read: (String) -> String) -> String? {
  guard redaction == nil, policy != "aggregate-content" else { return nil }
  let names =
    policy == nil
    ? [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
    : [kAXTitleAttribute, kAXDescriptionAttribute]
  for attribute in names {
    let value = read(attribute)
    if !value.isEmpty { return value }
  }
  return ""
}
func uiSafeValue(_ redaction: String?, _ policy: String?, read: () -> String?) -> String? {
  guard redaction == nil, policy == nil else { return nil }
  return read()
}
func uiMatches(_ fields: [String], _ filter: String) -> Bool {
  filter.isEmpty || fields.contains { $0.range(of: filter, options: [.caseInsensitive]) != nil }
}
func uiSelection(_ parents: [Int?], _ matches: [Bool], _ limit: Int, priorities: [Int]? = nil) -> (
  indices: [Int], limited: Bool
) {
  var selected = Set<Int>()
  var limited = false
  let order =
    priorities == nil
    ? Array(matches.indices)
    : matches.indices.sorted {
      priorities![$0] == priorities![$1] ? $0 < $1 : priorities![$0] < priorities![$1]
    }
  for index in order where matches[index] {
    var additions = Set<Int>()
    var current: Int? = index
    while let value = current, !selected.contains(value) {
      additions.insert(value)
      current = parents[value]
    }
    if selected.count + additions.count > limit {
      if priorities == nil { return (selected.sorted(), true) }
      limited = true
      continue
    }
    selected.formUnion(additions)
  }
  return (selected.sorted(), limited)
}
func uiReadFailure(_ result: AXError, required: Bool = false) -> Bool {
  if result == .success { return false }
  if required { return true }
  return result != .attributeUnsupported && result != .actionUnsupported && result != .noValue
}
final class UIReader {
  let deadline: Date
  let maxCalls = 12000
  var calls = 0
  var failedReads = 0
  var errorCodes: [Int32: Int] = [:]
  var reasons: [String] = []
  init(_ deadline: Date) { self.deadline = deadline }
  func note(_ reason: String) { if !reasons.contains(reason) { reasons.append(reason) } }
  func failed(_ result: AXError) {
    failedReads += 1
    note("ax-read-error")
    if errorCodes[result.rawValue] != nil || errorCodes.count < 16 {
      errorCodes[result.rawValue, default: 0] += 1
    }
  }
  var axErrors: [[String: Any]] {
    errorCodes.keys.sorted().map { code in
      [
        "code": code, "name": AXError(rawValue: code).map(axErrorName) ?? "unknown",
        "count": errorCodes[code]!,
      ]
    }
  }
  var available: Bool {
    if Date() >= deadline {
      note("deadline")
      return false
    }
    if calls >= maxCalls {
      note("operation-limit")
      return false
    }
    return true
  }
  func permit(_ element: AXUIElement) -> Bool {
    guard available else { return false }
    // This configures this client's IPC timeout; it does not alter Slack's UI.
    calls += 1
    let configured = AXUIElementSetMessagingTimeout(
      element, Float(min(0.15, max(0.001, deadline.timeIntervalSinceNow))))
    guard configured == .success else {
      failed(configured)
      return false
    }
    return true
  }
  func value(_ element: AXUIElement, _ attribute: String, required: Bool = false) -> CFTypeRef? {
    guard permit(element) else { return nil }
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if uiReadFailure(result, required: required) {
      failed(result)
    }
    guard result == .success else { return nil }
    return value
  }
  func string(_ element: AXUIElement, _ attribute: String) -> String {
    value(element, attribute) as? String ?? ""
  }
  func names(_ element: AXUIElement, actions: Bool) -> [String]? {
    guard permit(element) else { return nil }
    var names: CFArray?
    let result =
      actions
      ? AXUIElementCopyActionNames(element, &names) : AXUIElementCopyAttributeNames(element, &names)
    if uiReadFailure(result) {
      failed(result)
    }
    guard result == .success else { return nil }
    return names as? [String] ?? []
  }
  func settable(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard permit(element) else { return nil }
    var settable = DarwinBoolean(false)
    let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    if uiReadFailure(result) {
      failed(result)
    }
    guard result == .success else { return nil }
    return settable.boolValue
  }
  func bounds(_ element: AXUIElement) -> Any {
    guard let position = value(element, kAXPositionAttribute),
      let size = value(element, kAXSizeAttribute),
      CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return NSNull() }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
      [point.x, point.y, dimensions.width, dimensions.height].allSatisfy({ $0.isFinite })
    else { return NSNull() }
    return ["x": point.x, "y": point.y, "width": dimensions.width, "height": dimensions.height]
  }
}
struct UIRoots {
  let roots: [AXUIElement]
  let complete: Bool
  let repeatedReferences: Int
}
func uiDiscoverRoots(_ app: AXUIElement, _ reader: UIReader) -> UIRoots {
  var roots: [AXUIElement] = []
  var visited = 0
  var complete = true
  let seen = AXIdentitySet()
  let failuresBefore = reader.failedReads
  func visit(_ element: AXUIElement, _ depth: Int) {
    guard reader.available else {
      complete = false
      return
    }
    if !seen.insert(element) { return }
    guard visited < 1000, depth <= 20 else {
      complete = false
      return
    }
    visited += 1
    let discriminatorFailures = reader.failedReads
    let kind = reader.value(element, kAXRoleAttribute, required: true) as? String ?? ""
    if kind.isEmpty {
      complete = false
      return
    }
    if kind == "AXWebArea" {
      if let url = reader.value(element, kAXURLAttribute) as? URL, url.host == "app.slack.com",
        url.pathComponents.count >= 3, url.pathComponents[1] == "client"
      {
        roots.append(element)
      }
      return
    }
    let subrole = reader.string(element, kAXSubroleAttribute)
    let classes = reader.value(element, "AXDOMClassList") as? [String] ?? []
    let redacted = uiObservedRedaction(
      kind, subrole, classes, failedReads: reader.failedReads - discriminatorFailures)
    if redacted == "unreadable-content" { complete = false }
    let requiresChildren = [
      "AXApplication", "AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup", "AXToolbar",
    ].contains(kind)
    var children = uiSafeChildren(
      redacted,
      read: {
        reader.value(element, kAXChildrenAttribute, required: requiresChildren) as? [AXUIElement]
          ?? []
      })
    if kind == "AXApplication", redacted == nil {
      children = mergeAXChildren(
        children, windows: reader.value(element, kAXWindowsAttribute) as? [AXUIElement] ?? [])
    }
    for child in children {
      if !complete { break }
      visit(child, depth + 1)
    }
  }
  visit(app, 0)
  return UIRoots(
    roots: roots, complete: complete && reader.failedReads == failuresBefore && reader.available,
    repeatedReferences: seen.repeatedReferences)
}
func uiBounded(_ value: String, _ field: String, _ truncated: inout [String], limit: Int = 1000)
  -> String
{
  if value.unicodeScalars.count <= limit { return value }
  truncated.append(field)
  return String(String.UnicodeScalarView(value.unicodeScalars.prefix(limit)))
}
func uiDiagnosticPriority(
  _ role: String, _ id: String, _ label: String, _ classes: [String], _ focused: Bool
) -> Int? {
  if focused || ["AXDialog", "AXSheet", "AXMenu"].contains(role)
    || (role == "AXComboBox" && label == "Query")
  {
    return 0
  }
  if ["AXComboBox", "AXTextField", "AXCheckBox", "AXRadioButton"].contains(role) { return 1 }
  if role == "AXList" || classes.contains("p-view_contents")
    || classes.contains("p-client_workspace_wrapper")
  {
    return 2
  }
  if ["AXButton", "AXPopUpButton"].contains(role) { return 3 }
  return nil
}
func uiIdentity(_ root: AXUIElement, _ reader: UIReader, workspace: Bool) -> [String: Any] {
  var clipped: [String] = []
  let failuresBefore = reader.failedReads
  let kind = reader.value(root, kAXRoleAttribute, required: true) as? String ?? ""
  let readable = workspace && kind == "AXWebArea" && reader.failedReads == failuresBefore
  var result: [String: Any] = [
    "role": uiBounded(kind, "role", &clipped, limit: 128),
    "title": readable
      ? uiBounded(reader.string(root, kAXTitleAttribute), "title", &clipped) as Any : NSNull(),
    "url": readable
      ? (reader.value(root, kAXURLAttribute) as? URL).map {
        uiBounded($0.absoluteString, "url", &clipped)
      } as Any? ?? NSNull() : NSNull(),
  ]
  if let raw = reader.value(root, kAXWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
    let window = raw as! AXUIElement
    result["window"] = [
      "title": readable
        ? uiBounded(reader.string(window, kAXTitleAttribute), "window.title", &clipped) as Any
        : NSNull(), "bounds": reader.bounds(window),
    ]
  } else {
    result["window"] = NSNull()
  }
  if !clipped.isEmpty { result["truncatedFields"] = clipped }
  return result
}
func uiCapture(
  _ app: AXUIElement, _ options: UIOptions, budget: TimeInterval = 8, diagnostic: Bool = false
) -> [String: Any] {
  let start = Date()
  let deadline = start.addingTimeInterval(budget)
  let reader = UIReader(deadline)
  let discovered = uiDiscoverRoots(app, reader)
  let unique = discovered.complete && discovered.roots.count == 1
  let root = unique ? discovered.roots[0] : app
  let before = uiIdentity(root, reader, workspace: unique)
  var records: [[String: Any]] = []
  var elements: [AXUIElement] = []
  var parents: [Int?] = []
  var matches: [Bool] = []
  var redactedCount = 0
  var priorities: [Int] = []
  let seen = AXIdentitySet()
  func note(_ reason: String) { reader.note(reason) }
  func visit(_ element: AXUIElement, _ parent: Int?, _ depth: Int) {
    guard reader.available else { return }
    if !seen.insert(element) { return }
    guard records.count < 5000 else {
      note("visited-limit")
      return
    }
    let discriminatorFailures = reader.failedReads
    let rawKind = reader.value(element, kAXRoleAttribute, required: true) as? String ?? ""
    let rawSubrole = reader.string(element, kAXSubroleAttribute)
    let rawClasses = reader.value(element, "AXDOMClassList") as? [String] ?? []
    let redacted = uiObservedRedaction(
      rawKind, rawSubrole, rawClasses, failedReads: reader.failedReads - discriminatorFailures)
    var clipped: [String] = []
    let kind = uiBounded(rawKind, "role", &clipped, limit: 128)
    let subrole = uiBounded(rawSubrole, "subrole", &clipped, limit: 128)
    let domClasses = rawClasses.prefix(128).map { uiBounded($0, "classes", &clipped, limit: 256) }
    if rawClasses.count > 128 { clipped.append("classes") }
    let policy = uiContentPolicy(kind, domClasses)
    let safeLabel = uiSafeLabel(redacted, policy, read: { reader.string(element, $0) })
    let name = safeLabel.map { uiBounded($0, "label", &clipped) } ?? ""
    let id = uiBounded(reader.string(element, "AXDOMIdentifier"), "id", &clipped)
    let priority =
      diagnostic
      ? uiDiagnosticPriority(
        kind, id, name, domClasses, (reader.value(element, kAXFocusedAttribute) as? Bool) == true)
      : nil
    let matched =
      diagnostic
      ? priority != nil : uiMatches([kind, subrole, id, name] + domClasses, options.filter)
    let index = records.count
    var record: [String: Any] = [
      "index": index, "parent": parent as Any? ?? NSNull(), "depth": depth, "matched": matched,
      "role": kind, "subrole": subrole, "id": id, "classes": domClasses,
      "label": safeLabel != nil ? name as Any : NSNull(),
      "value": NSNull(), "url": NSNull(), "actions": NSNull(), "attributeNames": NSNull(),
      "settableAttributeNames": NSNull(), "unknownSettableAttributeNames": NSNull(),
      "enabled": NSNull(), "focused": NSNull(), "selected": NSNull(), "expanded": NSNull(),
      "bounds": NSNull(), "redacted": redacted as Any? ?? NSNull(),
    ]
    if let policy { record["contentOmitted"] = policy }
    if let redacted {
      record["redacted"] = redacted
      redactedCount += 1
      note("redacted-subtree")
    }
    if !clipped.isEmpty {
      record["truncatedFields"] = Array(Set(clipped)).sorted()
      note("field-limit")
    }
    records.append(record)
    elements.append(element)
    parents.append(parent)
    matches.append(matched)
    priorities.append(priority ?? 4)
    if !diagnostic && uiSelection(parents, matches, options.limit).limited {
      note("result-limit")
      return
    }
    var children = uiSafeChildren(
      redacted,
      read: {
        reader.value(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
      })
    if rawKind == "AXApplication", redacted == nil {
      children = mergeAXChildren(
        children, windows: reader.value(element, kAXWindowsAttribute) as? [AXUIElement] ?? [])
    }
    if depth == options.depth {
      if children.contains(where: { !seen.contains($0) }) { note("depth-limit") }
      return
    }
    for child in children {
      if reader.reasons.contains("result-limit") || !reader.available
        || reader.reasons.contains("visited-limit")
      {
        break
      }
      visit(child, index, depth + 1)
    }
  }
  visit(root, nil, 0)
  let selected = uiSelection(
    parents, matches, options.limit, priorities: diagnostic ? priorities : nil)
  if selected.limited { note("result-limit") }
  for index in selected.indices {
    guard reader.available else { break }
    let element = elements[index]
    var clipped = records[index]["truncatedFields"] as? [String] ?? []
    if records[index]["redacted"] is NSNull && records[index]["contentOmitted"] == nil {
      let scalar = uiSafeValue(
        nil, nil,
        read: {
          let raw = reader.value(element, kAXValueAttribute)
          return (raw as? String) ?? (raw as? NSNumber)?.stringValue
        })
      if let value = scalar { records[index]["value"] = uiBounded(value, "value", &clipped) }
      if let url = reader.value(element, kAXURLAttribute) as? URL {
        records[index]["url"] = uiBounded(url.absoluteString, "url", &clipped)
      }
    }
    for (key, attribute) in [
      ("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute),
      ("selected", kAXSelectedAttribute), ("expanded", kAXExpandedAttribute),
    ] {
      records[index][key] = (reader.value(element, attribute) as? Bool) as Any? ?? NSNull()
    }
    records[index]["bounds"] = reader.bounds(element)
    if !clipped.isEmpty {
      records[index]["truncatedFields"] = Array(Set(clipped)).sorted()
      note("field-limit")
    }
    if let names = reader.names(element, actions: true) {
      if names.contains(where: { $0.unicodeScalars.count > 128 }) {
        note("capability-limit")
      } else {
        records[index]["actions"] = Array(names.prefix(128))
      }
      if names.count > 128 { note("capability-limit") }
    }
    if let allNames = reader.names(element, actions: false) {
      let names = Array(allNames.prefix(128))
      if names.contains(where: { $0.unicodeScalars.count > 128 }) {
        note("capability-limit")
        continue
      }
      records[index]["attributeNames"] = names
      if allNames.count > 128 { note("capability-limit") }
      var settable: [String] = []
      var unknown: [String] = []
      for name in names {
        if let enabled = reader.settable(element, name) {
          if enabled { settable.append(name) }
        } else {
          unknown.append(name)
        }
      }
      records[index]["settableAttributeNames"] = settable
      records[index]["unknownSettableAttributeNames"] = unknown
    }
  }
  let after = uiIdentity(root, reader, workspace: unique)
  let finalRoots = uiDiscoverRoots(app, reader)
  if !finalRoots.complete && reader.available { note("root-selection-limit") }
  if before["truncatedFields"] != nil || after["truncatedFields"] != nil { note("field-limit") }
  let identityMatched: Any =
    unique && finalRoots.complete && reader.failedReads == 0 && before["truncatedFields"] == nil
      && after["truncatedFields"] == nil
    ? (finalRoots.roots.count == 1 && CFEqual(root, finalRoots.roots[0])
      && NSDictionary(dictionary: before).isEqual(to: after)) as Any : NSNull()
  let reasons = reader.reasons
  let selection =
    !discovered.complete
    ? "selection-incomplete"
    : unique
      ? "unique-workspace" : discovered.roots.isEmpty ? "no-workspace" : "ambiguous-workspaces"
  return [
    "captureId": UUID().uuidString, "captureStartedAt": ISO8601DateFormatter().string(from: start),
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "root": [
      "kind": unique ? "workspace" : "application", "selection": selection,
      "before": before, "after": after, "viewIdentityMatched": identityMatched,
    ],
    "preparation": ["requested": options.prepare, "steps": options.prepare ? recoverySteps : []],
    "nodes": selected.indices.map { records[$0] },
    "coverage": [
      "complete": false,
      "scanComplete": !reasons.contains(where: {
        !["capability-limit", "field-limit"].contains($0)
      }), "selectionMode": diagnostic ? "diagnostic-controls" : "substring",
      "visitedCount": records.count,
      "repeatedReferences": seen.repeatedReferences,
      "rootRepeatedReferences": discovered.repeatedReferences + finalRoots.repeatedReferences,
      "matchedCount": matches.filter { $0 }.count, "returnedCount": selected.indices.count,
      "redactedCount": redactedCount, "limit": options.limit, "maxDepth": options.depth,
      "filter": options.filter, "truncated": !reasons.isEmpty, "reasons": reasons,
      "readCalls": reader.calls, "maxReadCalls": reader.maxCalls,
      "failedReadCalls": reader.failedReads, "axErrors": reader.axErrors,
      "budgetMs": Int(budget * 1000),
    ],
  ]
}

var diagnosticApp: AXUIElement?
var diagnosticExpectedScope: [String: Any] = [:]
func afterErrorObservation() -> [String: Any]? {
  guard !interrupted, let app = diagnosticApp, AXIsProcessTrusted(),
    let options = try? UIOptions(["--ui", "--limit=60", "--depth=30"])
  else { return nil }
  return [
    "phase": "after-error", "readOnly": true, "expectedScope": diagnosticExpectedScope,
    "ui": uiCapture(app, options, budget: 2, diagnostic: true),
  ]
}
func uiInspection(
  _ app: AXUIElement, _ pid: pid_t, _ options: UIOptions, accessibilityReady: Bool = true
) throws -> [String: Any] {
  let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let cursor = CGEvent(source: nil)?.location ?? .zero
  if options.prepare && accessibilityReady { try prepareAccessibility(app) }
  let capture = uiCapture(app, options)
  let afterForeground = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let afterCursor = CGEvent(source: nil)?.location ?? .zero
  return [
    "operation": "inspect", "mode": "ui", "pid": pid, "ui": capture,
    "desktop": [
      "foregroundBefore": foreground, "foregroundAfter": afterForeground,
      "cursorBefore": [cursor.x, cursor.y], "cursorAfter": [afterCursor.x, afterCursor.y],
      "samples": desktopSamples,
      "scope":
        "Before/after evidence only; UI inspection posts no input. User app switching is allowed.",
    ],
    "verification":
      "Bounded current accessibility observations; capture-local indexes are not input targets",
  ]
}
