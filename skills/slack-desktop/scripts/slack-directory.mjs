// Pure validation and rendering of directory receipts (browse-channels /
// browse-people). No UI or persistence.
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  [...value].length <= maximum &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const stopReasons = new Set(['no-progress', 'page-limit', 'no-scroll', 'time-limit']);
export const directoryOperations = new Set(['browse-channels', 'browse-people']);

function channelRecord(record) {
  requireState(
    object(record) &&
      /^[CG][A-Z0-9]{2,30}$/.test(record.id ?? '') &&
      safeText(record.name, 120) &&
      typeof record.joined === 'boolean' &&
      (record.memberCount === undefined ||
        (Number.isSafeInteger(record.memberCount) && record.memberCount >= 0)) &&
      (record.description === undefined || safeText(record.description, 1000)),
    'Channel directory record is invalid'
  );
  return {
    id: record.id,
    name: record.name,
    joined: record.joined,
    ...(record.memberCount === undefined ? {} : { memberCount: record.memberCount }),
    ...(record.description === undefined ? {} : { description: record.description }),
  };
}

function personRecord(record) {
  requireState(
    object(record) &&
      /^[UW][A-Z0-9]{2,30}$/.test(record.id ?? '') &&
      safeText(record.name, 200) &&
      (record.title === undefined || safeText(record.title, 500)),
    'People directory record is invalid'
  );
  return {
    id: record.id,
    name: record.name,
    ...(record.title === undefined ? {} : { title: record.title }),
  };
}

export function compactDirectory(receipt, operation) {
  requireState(directoryOperations.has(operation), 'Unsupported directory operation');
  requireState(object(receipt), 'Directory receipt is unavailable');
  requireState(
    ['ok', 'stopped'].includes(receipt.status) &&
      (receipt.operation === operation ||
        (receipt.status === 'stopped' && receipt.operation === undefined)),
    'Directory receipt status or operation is invalid'
  );
  const base = {
    schemaVersion: 1,
    operation,
    status: receipt.status,
    ...(receipt.observedAt ? { observedAt: receipt.observedAt } : {}),
  };
  if (receipt.status === 'stopped')
    return {
      ...base,
      error: typeof receipt.error === 'string' ? receipt.error : 'Directory read stopped',
      next:
        typeof receipt.next === 'string'
          ? receipt.next
          : 'Inspect the current Slack view before another request; no input is replayed.',
    };
  requireState(
    Array.isArray(receipt.records) &&
      receipt.records.length <= 10000 &&
      Number.isSafeInteger(receipt.scrollSteps) &&
      receipt.scrollSteps >= 0 &&
      stopReasons.has(receipt.stopReason) &&
      typeof receipt.directoryOpened === 'boolean',
    'Directory receipt evidence is missing or inconsistent'
  );
  const records = receipt.records.map(
    operation === 'browse-channels' ? channelRecord : personRecord
  );
  requireState(
    new Set(records.map((record) => record.id)).size === records.length,
    'Directory records are duplicated'
  );
  const key = operation === 'browse-channels' ? 'channels' : 'people';
  return {
    ...base,
    [key]: records,
    coverage: {
      scope: `Slack directory ${key} tab`,
      // Slack loads only a first batch (about 50) that further scrolling does
      // not extend, so a directory read is never claimed complete.
      complete: false,
      collected: records.length,
      scrollSteps: receipt.scrollSteps,
      stopReason: receipt.stopReason,
    },
  };
}

export function renderDirectory(compact) {
  const channels = compact.operation === 'browse-channels';
  const records = channels ? compact.channels : compact.people;
  const lines = [
    `${channels ? 'Channel' : 'People'} directory — ${records.length} ${channels ? 'channels' : 'people'}`,
    '',
    ...records
      .slice(0, 200)
      .map((record) =>
        channels
          ? `- #${record.name}${record.memberCount === undefined ? '' : ` · ${record.memberCount} ${record.memberCount === 1 ? 'member' : 'members'}`}${record.joined ? ' · joined' : ''}`
          : `- ${record.name}${record.title ? ` · ${record.title}` : ''}`
      ),
  ];
  if (records.length > 200)
    lines.push(`${records.length - 200} more omitted; use --format=json for all.`);
  lines.push(
    '',
    `Slack's directory loads only its first batch (about 50) here, so this list may be incomplete (${compact.coverage.stopReason}).`
  );
  return lines.join('\n');
}
