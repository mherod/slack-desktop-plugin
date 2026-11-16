// Filesystem-only publisher for a completed, independently selected Slack download.
// No application, network, clipboard or source-deletion capability belongs here.
import CryptoKit
import Darwin
import Foundation

let maximumBytes: Int64 = 256 * 1024 * 1024
let maximumAttributeBytes = 16 * 1024 * 1024
let started = ProcessInfo.processInfo.systemUptime
let interrupted = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
interrupted.initialize(to: 0)
var action = sigaction()
action.__sigaction_u.__sa_handler = { value in interrupted.pointee = value }
sigemptyset(&action.sa_mask)
action.sa_flags = 0
for value in [SIGINT, SIGTERM, SIGALRM] { _ = sigaction(value, &action, nil) }
signal(SIGPIPE, SIG_IGN)
alarm(60)

struct Failure: Error, CustomStringConvertible {
  let description: String
}
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw Failure(description: message) }
}
func checkpoint() throws {
  if interrupted.pointee == SIGALRM || ProcessInfo.processInfo.systemUptime - started >= 60 {
    throw Failure(description: "File publication reached its 60-second time limit")
  }
  try require(interrupted.pointee == 0, "File publication cancelled")
}
func systemFailure(_ message: String) -> Failure {
  Failure(description: "\(message): \(String(cString: strerror(errno)))")
}
func fileStat(_ fd: Int32) throws -> stat {
  var value = stat()
  guard fstat(fd, &value) == 0 else { throw systemFailure("Could not verify open file") }
  return value
}
func sameObject(_ left: stat, _ right: stat) -> Bool {
  left.st_dev == right.st_dev && left.st_ino == right.st_ino
}
func sameContents(_ left: stat, _ right: stat) -> Bool {
  sameObject(left, right) && left.st_size == right.st_size
    && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
    && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
}
func identity(_ value: stat) throws -> [String: String] {
  let (seconds, overflow) = Int64(value.st_mtimespec.tv_sec).multipliedReportingOverflow(
    by: 1_000_000_000)
  let (nanoseconds, additionOverflow) = seconds.addingReportingOverflow(
    Int64(value.st_mtimespec.tv_nsec))
  try require(!overflow && !additionOverflow, "Source modification time exceeds supported bounds")
  return [
    "device": String(UInt32(bitPattern: value.st_dev)), "inode": String(value.st_ino),
    "size": String(value.st_size), "mtimeNs": String(nanoseconds),
  ]
}
func readRequest() throws -> [String: Any] {
  var bytes = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while true {
    try checkpoint()
    var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    let ready = poll(&descriptor, 1, 100)
    if ready < 0 {
      if errno == EINTR { continue }
      throw systemFailure("Could not read publisher request")
    }
    if ready == 0 { continue }
    let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
    if count < 0 {
      if errno == EINTR { continue }
      throw systemFailure("Could not read publisher request")
    }
    if count == 0 { break }
    bytes.append(contentsOf: buffer.prefix(count))
    try require(bytes.count <= 32 * 1024, "Publisher request exceeds 32 KiB")
  }
  let value = try JSONSerialization.jsonObject(with: bytes)
  guard let request = value as? [String: Any] else {
    throw Failure(description: "Publisher request must be a JSON object")
  }
  try require(
    Set(request.keys) == ["sourcePath", "destination", "expectedSource", "expectedParent"],
    "Publisher request fields are invalid")
  return request
}
func absolutePath(_ value: Any?, _ name: String) throws -> String {
  guard let path = value as? String else {
    throw Failure(description: "\(name) must be an absolute path")
  }
  try require(
    path.hasPrefix("/") && path.utf8.count <= 16 * 1024 && !path.hasSuffix("/")
      && !path.unicodeScalars.contains(where: {
        $0.value < 32 || (127...159).contains($0.value)
      }), "\(name) must be an absolute file path without control characters")
  return path
}
func canonicalParent(_ value: String) throws -> String {
  guard let resolved = realpath(value, nil) else {
    throw systemFailure("Destination parent must already exist")
  }
  defer { free(resolved) }
  return String(cString: resolved)
}
func checkedAttributes(_ fd: Int32) throws -> [String: Data] {
  try checkpoint()
  let count = flistxattr(fd, nil, 0, 0)
  guard count >= 0 else { throw systemFailure("Could not list file attributes") }
  try require(count <= 64 * 1024, "File attribute name inventory exceeds bounds")
  if count == 0 { return [:] }
  var names = [CChar](repeating: 0, count: count)
  let received = flistxattr(fd, &names, names.count, 0)
  guard received >= 0 else { throw systemFailure("File attributes changed while listing") }
  try require(received == count, "File attribute name inventory changed while listing")
  let entries = names.split(separator: 0)
  try require(entries.count <= 256, "File attribute count exceeds bounds")
  var attributes: [String: Data] = [:]
  var total = 0
  for entry in entries {
    try checkpoint()
    guard let name = String(bytes: entry.map { UInt8(bitPattern: $0) }, encoding: .utf8) else {
      throw Failure(description: "File attribute name encoding is unsupported")
    }
    try require(attributes[name] == nil, "File attribute names are ambiguous")
    let size = fgetxattr(fd, name, nil, 0, 0, 0)
    guard size >= 0 else { throw systemFailure("Could not read source attribute size") }
    try require(size <= maximumAttributeBytes - total, "File attributes exceed 16 MiB")
    var data = Data(count: size)
    let copied = data.withUnsafeMutableBytes {
      fgetxattr(fd, name, $0.baseAddress, $0.count, 0, 0)
    }
    guard copied >= 0 else { throw systemFailure("Could not read source attribute") }
    try require(copied == size, "File attribute changed while reading")
    attributes[name] = data
    total += size
  }
  return attributes
}
// macOS can add provenance when a newly quarantined staged file is first read.
// Preserve every source attribute exactly; only a new bounded provenance value
// is permitted, then pin the complete staged attribute set through publication.
func verifiedTargetAttributes(_ source: [String: Data], _ target: [String: Data]) throws
  -> [String: Data]
{
  try require(
    source.allSatisfy { target[$0.key] == $0.value },
    "Staged file attributes were not preserved")
  let added = Set(target.keys).subtracting(source.keys)
  try require(
    added.isEmpty
      || (added == ["com.apple.provenance"]
        && (1...4096).contains(target["com.apple.provenance"]?.count ?? 0)),
    "Staged file acquired unsupported additional attributes")
  return target
}
func checkSource(_ fd: Int32, _ expected: [String: String]) throws -> stat {
  try checkpoint()
  let value = try fileStat(fd)
  try require(value.st_mode & S_IFMT == S_IFREG, "Source must be a regular file")
  try require(value.st_size >= 0 && value.st_size <= maximumBytes, "Source exceeds 256 MiB")
  try require(try identity(value) == expected, "Completed download source identity changed")
  return value
}
func awaitQuarantine(_ fd: Int32, _ expected: [String: String]) throws -> [String: Data] {
  let deadline = ProcessInfo.processInfo.systemUptime + 10
  repeat {
    _ = try checkSource(fd, expected)
    let size = fgetxattr(fd, "com.apple.quarantine", nil, 0, 0, 0)
    if size > 0 {
      let attributes = try checkedAttributes(fd)
      if attributes["com.apple.quarantine"]?.isEmpty == false { return attributes }
    } else if size < 0 && errno != ENOATTR {
      throw systemFailure("Could not verify download quarantine")
    }
    _ = poll(nil, 0, 50)
  } while ProcessInfo.processInfo.systemUptime < deadline
  throw Failure(description: "Completed download quarantine was not observed within 10 seconds")
}
func hashFile(_ fd: Int32, _ size: Int64) throws -> String {
  let before = try fileStat(fd)
  try require(before.st_size == size, "File size changed before readback")
  var digest = SHA256()
  var offset: Int64 = 0
  var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
  while offset < size {
    try checkpoint()
    let requested = min(buffer.count, Int(size - offset))
    let count = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, requested, offset) }
    if count < 0 {
      if errno == EINTR { continue }
      throw systemFailure("Could not read back saved bytes")
    }
    try require(count > 0, "File ended before its verified size")
    digest.update(data: Data(buffer.prefix(count)))
    offset += Int64(count)
  }
  var extra: UInt8 = 0
  let remaining = pread(fd, &extra, 1, offset)
  try require(remaining == 0, "File grew or changed during verification")
  let after = try fileStat(fd)
  try require(
    sameContents(before, after)
      && before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec
      && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
    "File changed during independent readback")
  return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
func copyBytes(_ source: Int32, _ target: Int32, _ size: Int64) throws -> String {
  var digest = SHA256()
  var offset: Int64 = 0
  var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
  while offset < size {
    try checkpoint()
    let count = buffer.withUnsafeMutableBytes {
      pread(source, $0.baseAddress, min($0.count, Int(size - offset)), offset)
    }
    if count < 0 {
      if errno == EINTR { continue }
      throw systemFailure("Could not read completed download")
    }
    try require(count > 0, "Completed download ended before its verified size")
    digest.update(data: Data(buffer.prefix(count)))
    var written = 0
    while written < count {
      try checkpoint()
      let amount = buffer.withUnsafeBytes {
        pwrite(
          target, $0.baseAddress!.advanced(by: written), count - written, offset + Int64(written))
      }
      if amount < 0 {
        if errno == EINTR { continue }
        throw systemFailure("Could not stage saved bytes")
      }
      try require(amount > 0, "Staging file did not accept saved bytes")
      written += amount
    }
    offset += Int64(count)
  }
  return digest.finalize().map { String(format: "%02x", $0) }.joined()
}

var receipt: [String: Any] = [
  "operation": "save-media-publish", "status": "stopped",
  "artifact": ["path": NSNull(), "published": false, "verified": false],
]
var artifact: [String: Any] = ["path": NSNull(), "published": false, "verified": false]
var parentFD: Int32 = -1
var stagingFD: Int32 = -1
var stagingName: String?
var stagingIdentity: stat?

func cleanupStaging() throws {
  guard let name = stagingName, let owned = stagingIdentity, parentFD >= 0 else { return }
  var observed = stat()
  let result = fstatat(parentFD, name, &observed, AT_SYMLINK_NOFOLLOW)
  if result == -1 && errno == ENOENT {
    stagingName = nil
    return
  }
  try require(
    result == 0 && sameObject(observed, owned),
    "Staging path changed; unrelated file left untouched")
  guard unlinkat(parentFD, name, 0) == 0 else {
    throw systemFailure("Could not remove owned staging file")
  }
  stagingName = nil
}

do {
  try require(CommandLine.arguments.count == 1, "Publisher accepts only its JSON stdin request")
  let request = try readRequest()
  let sourcePath = try absolutePath(request["sourcePath"], "Source")
  let destination = try absolutePath(request["destination"], "Destination")
  artifact["path"] = destination
  guard let expected = request["expectedSource"] as? [String: String] else {
    throw Failure(description: "Expected source identity must contain BigInt decimal strings")
  }
  try require(
    Set(expected.keys) == ["device", "inode", "size", "mtimeNs"],
    "Expected source identity fields are invalid")
  for field in ["device", "inode", "size"] {
    guard let value = expected[field], let number = UInt64(value), String(number) == value else {
      throw Failure(description: "Expected source identity uses invalid decimal strings")
    }
  }
  guard let time = expected["mtimeNs"], let number = Int64(time), String(number) == time else {
    throw Failure(description: "Expected source modification time is invalid")
  }
  guard let expectedParent = request["expectedParent"] as? [String: String],
    Set(expectedParent.keys) == ["device", "inode"]
  else { throw Failure(description: "Expected destination parent identity is invalid") }
  for field in ["device", "inode"] {
    guard let value = expectedParent[field], let number = UInt64(value), String(number) == value
    else {
      throw Failure(
        description: "Expected destination parent identity uses invalid decimal strings")
    }
  }
  let name = (destination as NSString).lastPathComponent
  try require(!["", ".", ".."].contains(name), "Destination must name a file")
  let requestedParent = (destination as NSString).deletingLastPathComponent
  let parent = try canonicalParent(requestedParent)
  artifact["path"] = (parent as NSString).appendingPathComponent(name)
  parentFD = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard parentFD >= 0 else { throw systemFailure("Could not retain destination parent") }
  let parentIdentity = try fileStat(parentFD)
  try require(
    String(UInt32(bitPattern: parentIdentity.st_dev)) == expectedParent["device"]
      && String(parentIdentity.st_ino) == expectedParent["inode"],
    "Destination parent changed since download preflight")
  func checkParent() throws {
    try checkpoint()
    try require(try canonicalParent(requestedParent) == parent, "Destination parent path changed")
    var current = stat()
    try require(
      lstat(parent, &current) == 0 && sameObject(current, parentIdentity),
      "Destination parent identity changed")
  }
  var existing = stat()
  let exists = fstatat(parentFD, name, &existing, AT_SYMLINK_NOFOLLOW)
  try require(
    exists == -1 && errno == ENOENT,
    "Destination already exists or cannot be checked; no overwrite performed")
  let sourceFD = open(sourcePath, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
  guard sourceFD >= 0 else {
    throw systemFailure("Could not retain download source without following symlinks")
  }
  defer { close(sourceFD) }
  _ = try checkSource(sourceFD, expected)
  let attributes = try awaitQuarantine(sourceFD, expected)
  let sourceIdentity = try checkSource(sourceFD, expected)
  receipt["source"] = ["path": sourcePath, "identity": expected]
  try checkParent()
  let temporary = ".slack-save-\(UUID().uuidString).partial"
  stagingFD = openat(parentFD, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard stagingFD >= 0 else { throw systemFailure("Could not create private staging file") }
  stagingName = temporary
  stagingIdentity = try fileStat(stagingFD)
  guard let emptyACL = acl_init(0) else {
    throw systemFailure("Could not initialize private file access")
  }
  defer { acl_free(UnsafeMutableRawPointer(emptyACL)) }
  guard acl_set_fd(stagingFD, emptyACL) == 0 && fchmod(stagingFD, 0o600) == 0 else {
    throw systemFailure("Could not make staging file access private")
  }
  stagingIdentity = try fileStat(stagingFD)
  try require(stagingIdentity!.st_mode & 0o777 == 0o600, "Staging file permissions are not private")
  let expectedHash = try copyBytes(sourceFD, stagingFD, sourceIdentity.st_size)
  for name in attributes.keys.sorted() {
    try checkpoint()
    let data = attributes[name]!
    let result = data.withUnsafeBytes { fsetxattr(stagingFD, name, $0.baseAddress, $0.count, 0, 0) }
    guard result == 0 else { throw systemFailure("Could not preserve downloaded file attributes") }
  }
  guard fsync(stagingFD) == 0 else { throw systemFailure("Could not sync staged file") }
  let freshSource = try checkSource(sourceFD, expected)
  try require(
    freshSource.st_ctimespec.tv_sec == sourceIdentity.st_ctimespec.tv_sec
      && freshSource.st_ctimespec.tv_nsec == sourceIdentity.st_ctimespec.tv_nsec
      && (try checkedAttributes(sourceFD)) == attributes,
    "Completed download metadata changed during copying")
  let readbackFD = openat(parentFD, temporary, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard readbackFD >= 0 else { throw systemFailure("Could not independently reopen staged file") }
  defer { close(readbackFD) }
  let staged = try fileStat(readbackFD)
  try require(
    sameObject(staged, stagingIdentity!) && staged.st_size == sourceIdentity.st_size,
    "Staged file identity or size changed")
  try require(
    try hashFile(readbackFD, staged.st_size) == expectedHash, "Staged file hash verification failed"
  )
  let targetAttributes = try verifiedTargetAttributes(attributes, checkedAttributes(readbackFD))
  try checkParent()
  _ = try checkSource(sourceFD, expected)
  var beforeLink = stat()
  try require(
    fstatat(parentFD, temporary, &beforeLink, AT_SYMLINK_NOFOLLOW) == 0
      && sameObject(beforeLink, stagingIdentity!),
    "Staging path identity changed before publication")
  try checkpoint()
  guard linkat(parentFD, temporary, parentFD, name, 0) == 0 else {
    throw systemFailure("Could not publish without overwriting the destination")
  }
  artifact["published"] = true
  artifact["bytes"] = sourceIdentity.st_size
  artifact["expectedSha256"] = expectedHash
  try checkpoint()
  let publishedFD = openat(parentFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard publishedFD >= 0 else {
    throw systemFailure("Published file could not be reopened without following symlinks")
  }
  defer { close(publishedFD) }
  let published = try fileStat(publishedFD)
  try require(
    sameObject(published, stagingIdentity!) && published.st_size == sourceIdentity.st_size,
    "Published file identity or size verification failed")
  try require(
    try hashFile(publishedFD, published.st_size) == expectedHash,
    "Published file hash verification failed")
  try require(
    try checkedAttributes(publishedFD) == targetAttributes,
    "Published file attributes were not preserved"
  )
  try checkParent()
  var finalPath = stat()
  try require(
    fstatat(parentFD, name, &finalPath, AT_SYMLINK_NOFOLLOW) == 0
      && sameObject(finalPath, published), "Published destination path changed during verification")
  _ = try checkSource(sourceFD, expected)
  try require(
    try checkedAttributes(sourceFD) == attributes,
    "Source attributes changed before publication completed")
  try cleanupStaging()
  guard fsync(parentFD) == 0 else { throw systemFailure("Could not sync destination directory") }
  try checkParent()
  let finalFile = try fileStat(publishedFD)
  try require(
    sameContents(published, finalFile) && finalFile.st_mode & 0o777 == 0o600
      && fstatat(parentFD, name, &finalPath, AT_SYMLINK_NOFOLLOW) == 0
      && sameContents(finalPath, finalFile),
    "Published file changed before verification completed")
  try require(
    try checkedAttributes(publishedFD) == targetAttributes,
    "Published attributes changed before verification completed")
  try checkpoint()
  artifact["verified"] = true
  artifact["sha256"] = expectedHash
  artifact.removeValue(forKey: "expectedSha256")
  artifact["xattrCount"] = targetAttributes.count
  artifact["systemAddedXattrs"] = Set(targetAttributes.keys).subtracting(attributes.keys).sorted()
  artifact["quarantinePreserved"] = true
  receipt["status"] = "ok"
  receipt["verification"] = [
    "sourceUnchanged": true, "stagingReadBack": true, "publishedReadBack": true,
    "extendedAttributesPreserved": true, "noOverwrite": true,
  ]
} catch {
  receipt["error"] = String(describing: error)
  receipt["next"] =
    artifact["published"] as? Bool == true
    ? "The destination was published but final verification did not complete. Inspect the reported file; it was not removed."
    : "The downloaded source remains untouched. Inspect the failure before retrying publication."
}
do { try cleanupStaging() } catch {
  receipt["cleanupError"] = String(describing: error)
  receipt["status"] = "stopped"
}
if stagingFD >= 0 { close(stagingFD) }
if parentFD >= 0 { close(parentFD) }
alarm(0)
receipt["artifact"] = artifact
let output =
  (try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])) ?? Data("{}".utf8)
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([10]))
exit(receipt["status"] as? String == "ok" ? 0 : 1)
