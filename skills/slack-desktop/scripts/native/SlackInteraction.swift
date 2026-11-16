import AppKit
import ApplicationServices
import Darwin

enum InteractionMode: String { case background, foreground }
func interactionArguments(_ input: [String]) throws -> (InteractionMode, [String]) {
  var arguments = input
  var mode = InteractionMode.background
  if let first = arguments.first, first.hasPrefix("--interaction=") {
    guard let selected = InteractionMode(rawValue: String(first.dropFirst("--interaction=".count)))
    else { throw Failure(description: "Use --interaction=background or --interaction=foreground") }
    mode = selected
    arguments.removeFirst()
    try require(
      arguments.first?.hasPrefix("--interaction") != true,
      "Specify --interaction only once, before the native command")
  }
  if mode == .foreground {
    try require(
      [
        "channels", "dms", "channel", "search", "read-channel", "read-dm", "read-thread",
        "read-transcript", "save-media", "switch-workspace",
      ].contains(arguments.first ?? ""),
      "Foreground interaction requires a navigation, reading, search or save command; inspect, read-media and permissions remain read-only"
    )
  }
  return (mode, arguments)
}

// Foreground is an explicit one-command capability. Failed commands are never
// replayed, and relinquished foreground ownership can never be reacquired.
final class ForegroundInteraction {
  private(set) var state = "not-started"
  private(set) var activationRequested = false
  private(set) var activationAccepted: Bool?
  private(set) var activated = false
  private(set) var foregroundBefore: pid_t?
  private(set) var pid: pid_t?
  private(set) var ownershipLost = false
  var ready: Bool { state == "activated" || state == "already-foreground" }
  var receipt: [String: Any] {
    var result: [String: Any] = [
      "mode": "foreground", "activationRequested": activationRequested, "activated": activated,
      "state": state, "method": "NSRunningApplication.activate", "focusRestoration": "none",
      "ownershipLost": ownershipLost,
    ]
    if let activationAccepted { result["activationAccepted"] = activationAccepted }
    if let foregroundBefore { result["foregroundBefore"] = foregroundBefore }
    if let pid { result["pid"] = pid }
    return result
  }
  func start(
    pid: pid_t, originalForeground: pid_t, verify: () throws -> Void,
    foreground: () -> pid_t, interrupted: () -> Bool, physicalInputIdle: () -> Bool,
    activate: () -> Bool, wait: () -> Void
  ) throws {
    try require(state == "not-started", "Foreground activation cannot be repeated")
    self.pid = pid
    foregroundBefore = originalForeground
    do {
      try require(!interrupted(), "Interrupted before foreground activation")
      try verify()
      try require(
        pid > 0 && originalForeground > 0 && foreground() == originalForeground,
        "Foreground application changed before activation; no activation requested")
      try require(physicalInputIdle(), "Physical input held; foreground activation withheld")
      try require(!interrupted(), "Interrupted before foreground activation")
      try require(
        foreground() == originalForeground,
        "Foreground application changed before activation; no activation requested")
      if originalForeground == pid {
        state = "already-foreground"
      } else {
        activationRequested = true
        state = "activation-unconfirmed"
        activationAccepted = activate()
        activated = foreground() == pid
        try require(
          activationAccepted == true,
          "Slack foreground activation was not accepted; inspect state before retrying")
        for _ in 0..<20 {
          try require(!interrupted(), "Interrupted while awaiting foreground activation")
          let current = foreground()
          if current == pid {
            activated = true
            break
          }
          try require(
            current == originalForeground,
            "Foreground application changed during activation; no reactivation attempted")
          wait()
        }
        try require(activated, "Slack did not become foreground; no command input attempted")
        state = "activated"
      }
      try verify()
      try check(foreground: foreground(), interrupted: interrupted())
    } catch {
      state = "failed"
      throw error
    }
  }
  func check(foreground: pid_t, interrupted: Bool) throws {
    if interrupted || (ready && foreground != pid) { ownershipLost = true }
    try require(
      ready && !ownershipLost,
      "Foreground interaction interrupted or Slack lost foreground; no reactivation or further input"
    )
  }
}
func requireForegroundInput() throws {
  if let foregroundInteraction {
    try foregroundInteraction.check(
      foreground: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
      interrupted: interrupted)
  }
}
func interactionAXAction(_ element: AXUIElement, _ action: CFString) throws -> AXError {
  try requireForegroundInput()
  AXWalkMemo.invalidate()
  return AXUIElementPerformAction(element, action)
}
func interactionAXValue(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) throws
  -> AXError
{
  try requireForegroundInput()
  AXWalkMemo.invalidate()
  return AXUIElementSetAttributeValue(element, name, value)
}
func press(_ element: AXUIElement, inputDeadline: Date? = nil) throws {
  try require(
    (attr(element, kAXEnabledAttribute) as? Bool) == true
      && actions(element).contains(kAXPressAction),
    "Control is disabled or does not expose AXPress; input withheld")
  try requireGroupLookupBudget(inputDeadline)
  try require(
    try interactionAXAction(element, kAXPressAction as CFString) == .success,
    "Element did not accept AXPress; no coordinate fallback attempted")
}
func finalWindowInput<T>(
  _ expectedWindow: Int, currentWindow: () throws -> Int, noModal: () throws -> Void,
  verifyControl: () throws -> Void = {}, input: () throws -> T
) throws -> T {
  try verifyControl()
  try require(
    try currentWindow() == expectedWindow,
    "Slack window changed immediately before input; input withheld")
  try noModal()
  return try input()
}
func ownedSurfaceMatches(_ observed: [AXUIElement], _ owned: AXUIElement?) -> Bool {
  guard let owned else { return observed.isEmpty }
  return observed.count == 1 && CFEqual(observed[0], owned)
}
func requireSaveMediaInputBudget(_ deadline: Date, now: Date = Date()) throws {
  try require(now < deadline, "Save-media preparation exceeded its deadline; input withheld")
}
func settle(_ interval: TimeInterval = 0.4) {
  axPause(until: Date().addingTimeInterval(interval))
}
func sampleDesktop(_ stage: String) throws {
  try require(!interrupted, "Interrupted; inspect state before resuming")
  let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let cursor = CGEvent(source: nil)?.location ?? .zero
  desktopSamples.append([
    "stage": stage, "foregroundPid": foreground, "cursor": [cursor.x, cursor.y],
  ])
  if let foregroundInteraction, foregroundInteraction.ready || foregroundInteraction.ownershipLost {
    try foregroundInteraction.check(foreground: foreground, interrupted: interrupted)
    return
  }
  try require(
    initialForeground == slackPid || foreground != slackPid,
    "Slack became foreground; stopped without further input")
}
func backgroundKey(
  _ code: UInt16, _ character: String, _ root: AXUIElement, _ window: AXUIElement, _ id: Int,
  _ pid: pid_t, expectedSuggestion: AXUIElement? = nil, inputDeadline: Date? = nil,
  waitForCompletion: Bool = true
) throws {
  try sampleDesktop("before-key-\(code)")
  try require(try windowId(window, pid) == id, "Slack window changed; input withheld")
  try requireNoModal(window)
  try requireQueryFocus(root)
  try require(
    CGPreflightPostEventAccess(),
    "Post-event access unavailable in this execution context; input withheld. Run read-only permissions through the runner's approved execution context before considering macOS setup; do not replay input automatically"
  )
  try require(
    CGEventSource.flagsState(.combinedSessionState).intersection([
      .maskCommand, .maskControl, .maskAlternate, .maskShift,
    ]).isEmpty && NSEvent.pressedMouseButtons == 0, "Physical input held; input withheld")
  if code == 36 {
    let selected = try pickerSuggestions(root).filter {
      (attr($0.element, kAXSelectedAttribute) as? Bool) == true
    }
    try require(
      expectedSuggestion != nil && selected.count == 1
        && CFEqual(selected[0].element, expectedSuggestion!),
      "Selection changed immediately before Return; submission withheld")
  }
  func event(_ type: NSEvent.EventType) -> CGEvent? {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: id, context: nil, characters: character, charactersIgnoringModifiers: character,
      isARepeat: false, keyCode: code)?.cgEvent
  }
  guard let down = event(.keyDown), let emergencyUp = event(.keyUp) else {
    throw Failure(description: "Cannot construct key event")
  }
  do {
    // Slow AX preflights must not allow new input after a lookup expires.
    // Once key-down posts, key-up remains mandatory even past the deadline.
    try requireGroupLookupBudget(inputDeadline)
    try requireForegroundInput()
    defer { (event(.keyUp) ?? emergencyUp).postToPid(pid) }
    down.postToPid(pid)
    axPause(until: Date().addingTimeInterval(0.04))
  }
  if waitForCompletion { settle() }
  try sampleDesktop("after-key-\(code)")
}
func withDMQueryClipboard<T>(
  _ query: String, board: NSPasteboard = .general,
  _ body: (_ checkOwnership: () throws -> Void) throws -> T
) throws -> T {
  if #available(macOS 15.4, *), board.name == .general {
    try require(
      board.accessBehavior == .alwaysAllow, "Silent clipboard access unavailable; no clipboard read"
    )
  }
  let originalCount = board.changeCount
  guard let items = board.pasteboardItems else {
    throw Failure(description: "Clipboard items unavailable; unchanged")
  }
  var saved: [NSPasteboardItem] = []
  var bytes = 0
  for item in items {
    try require(saved.count < 64, "Clipboard exceeds preservation bound; unchanged")
    let copy = NSPasteboardItem()
    for type in item.types {
      guard let data = item.data(forType: type) else {
        throw Failure(description: "Clipboard representation unavailable; unchanged")
      }
      bytes += data.count
      try require(
        bytes <= 16 * 1024 * 1024 && copy.setData(data, forType: type),
        "Clipboard exceeds preservation bound; unchanged")
    }
    saved.append(copy)
  }
  try require(
    board.changeCount == originalCount, "Clipboard changed during preservation; paste withheld")
  let tagType = NSPasteboard.PasteboardType("org.slack-desktop.query-lease")
  let tag = UUID().uuidString
  let payload = NSPasteboardItem()
  try require(
    payload.setString(query, forType: .string) && payload.setString(tag, forType: tagType),
    "Query clipboard payload unavailable")
  let clearedCount = board.prepareForNewContents(with: [.currentHostOnly])
  var ownedCount = clearedCount
  defer {
    let ownsPayload = board.string(forType: tagType) == tag
    let ownsEmpty = ownedCount == clearedCount && board.pasteboardItems?.isEmpty == true
    if (ownsPayload || ownsEmpty) && board.changeCount == ownedCount {
      let restoreCount = board.prepareForNewContents(with: [.currentHostOnly])
      if board.changeCount == restoreCount && (saved.isEmpty || board.writeObjects(saved)) {
        let verificationCount = board.changeCount
        let restored = board.pasteboardItems ?? []
        let equal =
          restored.count == saved.count
          && zip(restored, saved).allSatisfy { left, right in
            left.types == right.types
              && left.types.allSatisfy { left.data(forType: $0) == right.data(forType: $0) }
          }
        clipboardRestoration =
          equal && board.changeCount == verificationCount
          ? "restored" : "changed-during-restoration"
      } else {
        clipboardRestoration = "restoration-failed-or-contended"
      }
    } else {
      clipboardRestoration = "newer-copy-preserved"
    }
    recoverySteps.append("Temporary query clipboard: \(clipboardRestoration!)")
  }
  try require(board.changeCount == clearedCount, "Clipboard changed after claim; paste withheld")
  try require(board.writeObjects([payload]), "Clipboard query write failed")
  ownedCount = board.changeCount
  func checkOwnership() throws {
    try require(
      board.string(forType: tagType) == tag && board.changeCount == ownedCount,
      "Clipboard changed before paste; paste withheld")
  }
  try checkOwnership()
  return try body(checkOwnership)
}
