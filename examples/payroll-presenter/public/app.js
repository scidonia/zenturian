const REASONS = {
  recipient_not_permitted: 'This person is not permitted to receive the report.',
  preparer_not_assigned: 'This person is not an active preparer for this shop.',
  directory_changed: 'The directory changed before the release could commit.',
  report_not_prepared: 'Prepare the report first.',
  unknown_report: 'The model has no report with that reference.',
};

const PERSON_STORY = {
  nora: 'Prepares this report. Opening it returns no pay.',
  alice: 'Bristol manager. Opening returns the two Bristol rows, until the transfer.',
  ben: 'Successor. Opening returns the rows only after he becomes manager.',
  cara: 'Cardiff manager. This Bristol report stays closed.',
  dana: 'Acting Bristol manager. Opening returns the rows only under policy v2, and only through 30 November.',
  sam: 'South Bristol manager. This North Bristol report stays closed.',
};

const KIND_LABELS = {
  prepare: 'Preparation',
  open: 'Open',
  body: 'Body-selected reader',
  policy: 'Policy',
  transfer: 'Management transfer',
  restore: 'Assignments restored',
  clock: 'Date',
  mixed: 'Mixed snapshot',
  reset: 'Reset',
  session: 'Session',
};

const buttons = [...document.querySelectorAll('button')];
const banner = document.querySelector('#banner');

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function personName(state, id) {
  return state.people.find((person) => person.id === id)?.name ?? id;
}

function shopLabel(state, id) {
  const shop = state.shops.find((record) => record.id === id);
  if (shop === undefined) return id;
  const tenant = shop.tenant.charAt(0).toUpperCase() + shop.tenant.slice(1);
  return `${tenant} · ${shop.name}`;
}

function roleLabel(role) {
  return role.replaceAll('-', ' ');
}

function formatDay(day) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

function assignmentsFor(state, principal) {
  const rank = new Map(state.shops.map((shop, index) => [shop.id, index]));
  return state.assignments
    .filter((assignment) => assignment.principal === principal)
    .sort((left, right) => (rank.get(left.shop) ?? 0) - (rank.get(right.shop) ?? 0));
}

function assignmentLine(state, assignment) {
  const span = assignment.to === null
    ? `from ${assignment.from}`
    : `${assignment.from} to ${assignment.to}`;
  return `${shopLabel(state, assignment.shop)} · ${roleLabel(assignment.role)} · ${span}`;
}

function renderMeters(state) {
  const chain = state.audit.ok ? 'verified' : 'failed';
  const fields = [
    ['Signed in', personName(state, state.session.principal)],
    ['As of', formatDay(state.asOf)],
    ['Policy', `${state.policy.version} · ${state.policy.hashPrefix}`],
    ['Directory', `version ${state.directoryVersion}`],
    ['Audit', chain],
  ];
  document.querySelector('#meters').replaceChildren(
    ...fields.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
  );
}

function renderPeople(state) {
  document.querySelector('#people').replaceChildren(
    ...state.people.map((person) => {
      const lines = assignmentsFor(state, person.id);
      return h('button', {
        type: 'button',
        className: 'person',
        'data-principal': person.id,
        'aria-pressed': person.id === state.session.principal ? 'true' : 'false',
      },
      h('strong', {}, person.name),
      h('small', {}, PERSON_STORY[person.id] ?? ''),
      ...(lines.length === 0
        ? [h('small', {}, 'Right now: no assignment')]
        : lines.map((assignment) => h('small', {
          className: assignment.active ? '' : 'inactive',
        }, `Right now: ${assignment.active ? 'active' : 'inactive'} · ${assignmentLine(state, assignment)}`))));
    }),
  );
}

function renderReportRef(state) {
  document.querySelector('#report-ref').textContent = state.reportId === null
    ? 'No report prepared in this session.'
    : `Report reference ${state.reportId}`;
}

function gloss(error) {
  if (error === null) return null;
  if (error.message.includes(' ')) return error.message;
  return REASONS[error.message] ?? REASONS[error.code] ?? error.message;
}

function activeRoles(state, id) {
  return state.assignments
    .filter((assignment) => assignment.principal === id && assignment.active)
    .map((assignment) => assignment.role);
}

function means(outcome, state) {
  if (outcome === null) return null;
  const name = outcome.actor === null ? null : personName(state, outcome.actor);
  const policy = state.policy.version;
  const day = formatDay(state.asOf);
  const roles = outcome.actor === null ? [] : activeRoles(state, outcome.actor);

  if (outcome.kind === 'prepare' && outcome.status === 200) {
    return 'This created a report reference and released no pay. Open it as Nora to see the preparer refused, then sign in as Alice and open it to see the two Bristol rows.';
  }
  if (outcome.kind === 'prepare') {
    return `${name} is signed in. Only Nora, the payroll preparer for North Bristol, can prepare this report. Nothing was created and no pay was returned.`;
  }
  if (outcome.kind === 'body') {
    return 'The session was Nora and the body named Alice. The model ignores the body and still treats Nora as the recipient. Nora cannot receive the report, so this response has no pay.';
  }
  if (outcome.kind === 'open' && outcome.status === 200) {
    if (roles.includes('acting-manager')) {
      return `${name} received the two Bristol rows, E101 and E102. Policy ${policy} allows an acting manager, and that appointment covers ${day}. Cardiff and South rows are not included.`;
    }
    return `${name} received the two Bristol rows, E101 and E102, because they are the active Bristol manager on ${day}. Cardiff and South rows are not included.`;
  }
  if (outcome.kind === 'open' && outcome.error?.message === 'recipient_not_permitted') {
    if (outcome.actor === 'nora') {
      return 'Nora prepared this report. The preparer is not a recipient, so opening it returns no pay.';
    }
    if (outcome.actor === 'cara') {
      return 'Cara manages Cardiff. A manager of another shop does not receive the North Bristol report, so this response has no pay.';
    }
    if (outcome.actor === 'sam') {
      return 'Sam manages South Bristol, a different tenant. He does not receive the North Bristol report, so this response has no pay.';
    }
    if (outcome.actor === 'ben') {
      return 'Ben is not the active Bristol manager on this date. The designated-successor role does not receive the report. Transfer management to Ben, then open again.';
    }
    if (outcome.actor === 'alice') {
      return 'Alice is no longer the active Bristol manager on this date, so she receives no pay. Open the report as Ben.';
    }
    if (outcome.actor === 'dana' && policy === 'v1') {
      return 'Dana is the acting manager. Policy v1 allows only the active manager, so she receives no pay. Switch to policy v2 and open again.';
    }
    if (outcome.actor === 'dana') {
      return `Dana's acting appointment ended on 30 November 2026. On ${day} she is not an acting manager, so policy ${policy} also returns no pay.`;
    }
    return `${name} is not allowed to receive this report under policy ${policy} on ${day}. This response has no pay.`;
  }
  if (outcome.kind === 'mixed') {
    return 'Alice opened a Bristol report whose snapshot also contained L3, a Cardiff row. Every row has to belong to the report before any pay is released. The release was refused and no amounts were returned. The report on the left is unchanged.';
  }
  if (outcome.kind === 'policy') {
    return policy === 'v2'
      ? 'Policy v2 is in force. An active acting manager can now receive the report. Sign in as Dana and open it. Her appointment covers 15 November and has ended on 1 December.'
      : 'Policy v1 is in force. Only the active Bristol manager can receive the report. Dana, the acting manager, is refused. Sign in as Alice and open it.';
  }
  if (outcome.kind === 'transfer') {
    return 'Alice stops being Bristol manager on 14 November 2026. Both model dates are after that, so she no longer receives the report. Ben is the manager from 1 November 2026. Open as Alice, then as Ben.';
  }
  if (outcome.kind === 'restore') {
    return 'Alice is the Bristol manager again. Ben is the designated successor, and that role does not receive the report. Open as Alice, then as Ben.';
  }
  if (outcome.kind === 'clock') {
    return `The model date is ${day}. Dana's acting appointment covers 15 November and has ended on 1 December. With policy v2, open as Dana.`;
  }
  if (outcome.kind === 'reset') {
    return 'The model is back to 15 November 2026, policy v1, and the original assignments. Alice manages Bristol. The signed-in person was kept. Prepare the report again.';
  }
  return null;
}

function renderOutcome(outcome, state) {
  if (outcome === null) {
    return h('div', { className: 'result' },
      h('h3', {}, 'Start here'),
      h('p', { className: 'means' }, 'Nora is signed in. Prepare the report, then open it as Nora. She should see no pay. Sign in as Alice and open it again. She should see E101 at GBP 3100.00 and E102 at GBP 2850.00.'));
  }

  const refused = outcome.error !== null || (typeof outcome.status === 'number' && outcome.status >= 400);
  const allowed = Array.isArray(outcome.rows) && outcome.rows.length > 0 && !refused;
  const who = outcome.actor === null ? '' : personName(state, outcome.actor);
  const title = who === ''
    ? (KIND_LABELS[outcome.kind] ?? 'Result')
    : `${KIND_LABELS[outcome.kind] ?? 'Result'} · ${who}`;
  const bits = [];
  if (typeof outcome.status === 'number') bits.push(`HTTP ${outcome.status}`);
  if (outcome.error !== null) {
    bits.push(outcome.error.code);
    if (!outcome.error.message.includes(' ') && outcome.error.message !== outcome.error.code) {
      bits.push(outcome.error.message);
    }
  }
  if (Array.isArray(outcome.rows)) bits.push(`${outcome.rows.length} rows`);
  if (outcome.noStore === true) bits.push('no-store');
  if (outcome.bodyReader !== null) bits.push(`body reader ${personName(state, outcome.bodyReader)}`);

  const body = [h('h3', {}, title)];
  const explanation = means(outcome, state);
  if (explanation !== null) body.push(h('p', { className: 'means' }, explanation));
  if (bits.length > 0) body.push(h('p', { className: 'meta' }, bits.join(' · ')));
  if (allowed) {
    body.push(h('table', { className: 'rows' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', {}, 'Gross pay'))),
      h('tbody', {}, ...outcome.rows.map((row) => h('tr', {},
        h('td', {}, row.employeeRef),
        h('td', {}, `GBP ${row.grossPay}`))))));
  } else if (Array.isArray(outcome.rows)) {
    body.push(h('p', { className: 'empty-rows' }, '0 rows'));
  }
  if (explanation === null) {
    const reason = gloss(outcome.error);
    if (reason !== null && reason.length > 0) body.push(h('p', { className: 'reason' }, reason));
  }
  if (outcome.note !== null) body.push(h('p', { className: 'note' }, outcome.note));
  return h('div', { className: `result ${allowed ? 'allow' : refused ? 'refuse' : ''}` }, ...body);
}

function renderMixed(state) {
  const host = document.querySelector('#mixed-result');
  if (state.mixed === null) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(h('div', { className: 'mixed' },
    h('h2', {}, 'Last mixed snapshot'),
    renderOutcome(state.mixed, state)));
}

function renderDirectory(state) {
  const rank = new Map(state.people.map((person, index) => [person.id, index]));
  document.querySelector('#directory').replaceChildren(
    ...state.shops.map((shop) => {
      const rows = state.assignments
        .filter((assignment) => assignment.shop === shop.id)
        .sort((left, right) => (rank.get(left.principal) ?? 0) - (rank.get(right.principal) ?? 0));
      return h('div', {},
        h('h3', {}, shopLabel(state, shop.id)),
        h('ul', {}, ...rows.map((assignment) => h('li', {
          className: assignment.active ? '' : 'inactive',
        },
        h('span', {}, `${personName(state, assignment.principal)} · ${roleLabel(assignment.role)}`),
        h('span', { className: 'tag' }, assignment.active ? 'Active' : 'Inactive')))));
    }),
  );
}

function recordLine(record, state) {
  if (record.type === 'promotion') {
    return [
      `#${record.seq}`,
      'policy change',
      record.approver,
      record.previousPolicyPrefix,
      'to',
      record.policyPrefix,
    ].filter((part) => part !== null && part !== undefined && part !== '').join(' ');
  }
  const reason = record.reason ?? (record.verdict === 'allow' ? 'released' : null);
  const verdict = record.verdict === 'allow' ? 'allowed' : record.verdict === 'refuse' ? 'refused' : record.verdict;
  return [
    `#${record.seq}`,
    record.person === null ? null : personName(state, record.person),
    verdict,
    reason,
    record.rowCount === null ? null : `${record.rowCount} rows`,
    record.directoryVersion === null ? null : `directory v${record.directoryVersion}`,
    record.policyPrefix === null ? null : `policy ${record.policyPrefix}`,
  ].filter((part) => part !== null && part !== undefined && part !== '').join(' · ');
}

function renderAudit(state) {
  const audit = state.audit;
  const chain = audit.ok
    ? `Audit chain verified. ${audit.count} entries, ${audit.releaseCount} release records, ${audit.promotionCount} promotion records. Head ${audit.headPrefix}.`
    : `Audit chain failed at entry ${audit.brokenAt}. ${audit.count} entries.`;
  const salary = audit.salaryValuesPresent
    ? 'The amounts are present in this record.'
    : 'The amounts are absent from this record.';
  const detector = audit.releaseViewDetector === null
    ? 'No successful open has returned pay yet, so there is no release view to compare.'
    : audit.releaseViewDetector
      ? 'The same check does find those amounts on the last released view, which is how you can see the check is working.'
      : 'The same check does not find those amounts on the last released view.';
  const records = audit.records.length === 0
    ? [h('li', {}, 'No release or promotion records yet.')]
    : audit.records.map((record) => h('li', {}, recordLine(record, state)));
  document.querySelector('#audit').replaceChildren(
    h('p', { className: 'chain' }, chain),
    h('p', { className: 'salary' }, `${salary} ${detector}`),
    h('ul', {}, ...records),
  );
}

function renderToggles(state) {
  for (const button of document.querySelectorAll('[data-policy]')) {
    button.setAttribute('aria-pressed', button.dataset.policy === state.policy.version ? 'true' : 'false');
  }
  for (const button of document.querySelectorAll('[data-day]')) {
    button.setAttribute('aria-pressed', button.dataset.day === state.asOf ? 'true' : 'false');
  }
}

function render(state) {
  renderMeters(state);
  renderPeople(state);
  renderReportRef(state);
  document.querySelector('#result').replaceChildren(renderOutcome(state.last, state));
  renderMixed(state);
  renderDirectory(state);
  renderAudit(state);
  renderToggles(state);
}

function setBusy(isBusy) {
  for (const button of buttons) button.disabled = isBusy;
  for (const button of document.querySelectorAll('#people button')) button.disabled = isBusy;
}

async function post(path, body) {
  setBusy(true);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json();
    if (!response.ok) {
      banner.hidden = false;
      banner.textContent = payload.error?.message ?? 'The presenter could not complete that action.';
      return;
    }
    banner.hidden = true;
    render(payload);
  } catch {
    banner.hidden = false;
    banner.textContent = 'The presenter is not reachable.';
  } finally {
    setBusy(false);
  }
}

document.querySelector('#people').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-principal]');
  if (button === null || button.disabled) return;
  post('/api/session', { principal: button.dataset.principal });
});

document.querySelector('#prepare').addEventListener('click', () => post('/api/prepare'));
document.querySelector('#open').addEventListener('click', () => post('/api/open'));
document.querySelector('#body').addEventListener('click', () => post('/api/open-body'));
document.querySelector('#transfer').addEventListener('click', () => post('/api/transfer'));
document.querySelector('#restore').addEventListener('click', () => post('/api/restore'));
document.querySelector('#mixed').addEventListener('click', () => post('/api/mixed'));
document.querySelector('#reset').addEventListener('click', () => post('/api/reset'));
document.querySelector('#reset-corner').addEventListener('click', () => post('/api/reset'));

for (const button of document.querySelectorAll('[data-policy]')) {
  button.addEventListener('click', () => post('/api/policy', { version: button.dataset.policy }));
}
for (const button of document.querySelectorAll('[data-day]')) {
  button.addEventListener('click', () => post('/api/clock', { day: button.dataset.day }));
}

fetch('/api/state', { headers: { accept: 'application/json' } })
  .then((response) => response.json())
  .then((state) => render(state))
  .catch(() => {
    banner.hidden = false;
    banner.textContent = 'The presenter is not reachable.';
  });
