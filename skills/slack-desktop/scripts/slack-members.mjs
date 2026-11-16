// Pure validation of the native members receipt. No UI or persistence.
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  [...value].length <= maximum &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const stopReasons = new Set(['complete', 'page-limit', 'no-progress', 'no-scroll', 'time-limit']);

export function compactMembers(receipt, requested) {
  requireState(object(receipt), 'Members receipt is unavailable');
  requireState(
    ['ok', 'stopped'].includes(receipt.status) &&
      (receipt.operation === 'members' ||
        (receipt.status === 'stopped' && receipt.operation === undefined)),
    'Members receipt status or operation is invalid'
  );
  const base = {
    schemaVersion: 1,
    operation: 'members',
    status: receipt.status,
    requested,
    ...(receipt.observedAt ? { observedAt: receipt.observedAt } : {}),
  };
  if (receipt.status === 'stopped') {
    const dialogMayBeOpen =
      (receipt.dialogOpened === true || receipt.dialogReused === true) &&
      receipt.dialogClosed !== true;
    return {
      ...base,
      error: typeof receipt.error === 'string' ? receipt.error : 'Members read stopped',
      next: dialogMayBeOpen
        ? 'Run close-members to close only the verified members dialog, then inspect the current Slack view before another request; no read is replayed.'
        : typeof receipt.next === 'string'
          ? receipt.next
          : 'Inspect the current Slack view before another request; no input is replayed.',
      // An opened dialog that was not verified closed may still be on screen.
      dialogMayBeOpen,
      ...(dialogMayBeOpen ? { navigation: { command: 'close-members', args: [] } } : {}),
    };
  }
  const url = (() => {
    try {
      return new URL(receipt.channel?.url);
    } catch {
      return null;
    }
  })();
  const channelId = url?.pathname.match(/^\/client\/[TE][A-Z0-9]+\/([CG][A-Z0-9]+)$/)?.[1];
  requireState(
    object(receipt.channel) &&
      safeText(receipt.channel.name, 80) &&
      url?.origin === 'https://app.slack.com' &&
      channelId &&
      Number.isSafeInteger(receipt.total) &&
      receipt.total >= 0 &&
      Array.isArray(receipt.members) &&
      receipt.members.length <= receipt.total &&
      Number.isSafeInteger(receipt.listPages) &&
      (receipt.listPages >= 1 ||
        (receipt.listPages === 0 &&
          receipt.stopReason === 'time-limit' &&
          receipt.members.length === 0 &&
          receipt.total > 0)) &&
      (receipt.memberFilter === undefined ||
        (object(receipt.memberFilter) &&
          receipt.memberFilter.status === 'verified-all' &&
          receipt.memberFilter.label === 'Filter by: All' &&
          receipt.memberFilter.value === 'All')) &&
      (receipt.maxSeconds === undefined ||
        (Number.isSafeInteger(receipt.maxSeconds) &&
          receipt.maxSeconds >= 1 &&
          receipt.maxSeconds <= 900)) &&
      stopReasons.has(receipt.stopReason) &&
      // Exactly one of: opened by this command, or reused because it was already open.
      typeof receipt.dialogOpened === 'boolean' &&
      typeof receipt.dialogReused === 'boolean' &&
      receipt.dialogOpened !== receipt.dialogReused &&
      receipt.dialogClosed === true,
    'Members receipt evidence is missing or inconsistent'
  );
  const ids = new Set();
  const members = receipt.members.map((member) => {
    const structuredName =
      safeText(member?.name, 200) &&
      member.label === undefined &&
      (member.title === undefined || safeText(member.title, 300));
    const observedLabel =
      member?.name === null &&
      safeText(member.label, 2000) &&
      member.label.trim().length > 0 &&
      member.title === undefined;
    requireState(
      object(member) &&
        /^[UW][A-Z0-9]{2,30}$/.test(member.id ?? '') &&
        !ids.has(member.id) &&
        (structuredName || observedLabel),
      'Member record is invalid or duplicated'
    );
    ids.add(member.id);
    return {
      id: member.id,
      name: member.name,
      ...(observedLabel ? { label: member.label } : {}),
      ...(member.title === undefined ? {} : { title: member.title }),
    };
  });
  const complete = members.length === receipt.total;
  requireState(
    (receipt.stopReason === 'complete') === complete,
    'Members completeness disagrees with the stop reason'
  );
  return {
    ...base,
    channel: { name: receipt.channel.name, id: channelId },
    total: receipt.total,
    members,
    coverage: {
      scope: 'channel details member list',
      complete,
      collected: members.length,
      pages: receipt.listPages,
      ...(receipt.memberFilter === undefined ? {} : { memberFilter: 'All' }),
      ...(receipt.maxSeconds === undefined ? {} : { maxSeconds: receipt.maxSeconds }),
      stopReason: receipt.stopReason,
    },
  };
}

export function renderMembers(compact) {
  const rows = compact.members.slice(0, 100);
  let labelsShortened = false;
  const lines = [
    `Members of #${compact.channel.name} — ${compact.members.length} of ${compact.total} listed`,
    '',
    ...rows.map((member) => {
      if (member.name !== null)
        return `- ${member.name}${member.title ? ` · ${member.title}` : ''}`;
      const characters = [...member.label];
      const shortened = characters.length > 300;
      labelsShortened ||= shortened;
      const label = shortened ? `${characters.slice(0, 299).join('')}…` : member.label;
      return `- [profile label; name unavailable] ${label}`;
    }),
  ];
  if (compact.members.length > 100)
    lines.push(`${compact.members.length - 100} more omitted; use --format=json for all.`);
  if (labelsShortened)
    lines.push('Profile labels are shortened; use --format=json for all captured text.');
  if (!compact.coverage.complete)
    lines.push(
      '',
      compact.coverage.stopReason === 'page-limit'
        ? 'Not every member was reached (page-limit); rerun without --pages to read the whole list.'
        : compact.coverage.stopReason === 'time-limit' && compact.coverage.maxSeconds < 900
          ? `Not every member was reached (time-limit); rerun with --max-seconds=900 for a longer bounded read.`
          : `Not every member was reached (${compact.coverage.stopReason}).`
    );
  return lines.join('\n');
}
