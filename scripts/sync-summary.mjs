// Describes how a spec sync changed the generated tools, as the spec-sync PR's title and body.
// The PR is squash-merged under its title, so the title is the line that lands in CHANGELOG.md.
//
// Usage: node scripts/sync-summary.mjs [base] [head]
//   base defaults to HEAD, head to the working tree. Under GitHub Actions it writes `title` and `body` to $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [base = 'HEAD', head] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });

function load(ref, file) {
  const path = `src/generated/${file}`;
  if (!ref) return JSON.parse(readFileSync(path, 'utf8'));
  try {
    return JSON.parse(git('show', `${ref}:${path}`));
  } catch {
    return undefined; // not generated yet at that ref
  }
}

const before = new Map((load(base, 'tools.json') ?? []).map((t) => [t.name, t]));
const after = new Map(load(head, 'tools.json').map((t) => [t.name, t]));
const schemasBefore = load(base, 'schemas.json') ?? {};
const schemasAfter = load(head, 'schemas.json');
const opsBefore = load(base, 'operations.json') ?? {};
const opsAfter = load(head, 'operations.json');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o ?? {});
const minus = (a, b) => a.filter((x) => !b.includes(x));
const union = (...lists) => [...new Set(lists.flat())];
const atMost = (names, n) => names.slice(0, n).join(', ') + (names.length > n ? ` and ${names.length - n} more` : '');

/** Schemas a tool or schema points to: pointer stubs, `schema "X"` in text, x-variants branches, a tool's responseSchema. */
function refs(node) {
  const out = new Set(node.responseSchema ? [node.responseSchema] : []);
  for (const m of JSON.stringify(node).matchAll(/jinshuju:\/\/schemas\/(\w+)|schema \\"(\w+)\\"/g))
    out.add(m[1] ?? m[2]);
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    for (const v of Object.values(n['x-variants'] ?? {})) if (typeof v === 'string') out.add(v);
    Object.values(n).forEach(walk);
  };
  walk(node);
  return [...out];
}

/** Schemas reachable from `roots` through pointers, roots included. */
function reachable(roots) {
  const out = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (out.has(name)) continue;
    out.add(name);
    queue.push(...refs(schemasAfter[name] ?? schemasBefore[name] ?? {}));
  }
  return out;
}

/** Every property name declared at any depth of the given JSON values. */
function propertyNames(...nodes) {
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'properties' && v && typeof v === 'object') keys(v).forEach((p) => out.add(p));
      walk(v);
    }
  };
  nodes.forEach(walk);
  return out;
}
/** Property names in `b` that `a` has nowhere, so moving a property around is not a new field. */
const newFields = (a, b) => [...b].filter((n) => !a.has(n));

const changedSchemas = union(keys(schemasBefore), keys(schemasAfter))
  .filter((n) => !same(schemasBefore[n], schemasAfter[n]))
  .sort();

const added = minus([...after.keys()], [...before.keys()]);
const removed = minus([...before.keys()], [...after.keys()]);
const changed = []; // { name, notes, schemas, fields }
for (const [name, tool] of after) {
  const old = before.get(name);
  if (!old) continue;
  const notes = [];
  const params = keys(tool.inputSchema?.properties);
  const oldParams = keys(old.inputSchema?.properties);
  const paramDiff = [...minus(params, oldParams).map((p) => `+${p}`), ...minus(oldParams, params).map((p) => `-${p}`)];
  if (paramDiff.length) notes.push(`params ${paramDiff.join(' ')}`);
  for (const field of union(keys(old), keys(tool))) {
    if (field !== 'params' && field !== 'paramNames' && !same(old[field], tool[field])) notes.push(field);
  }
  const oldReach = [...reachable(refs(old))];
  // Schemas the tool names itself come before the ones reached through them.
  const direct = union(refs(old), refs(tool));
  const viaSchemas = union(oldReach, [...reachable(refs(tool))])
    .filter((s) => changedSchemas.includes(s))
    .sort((a, b) => direct.includes(b) - direct.includes(a) || a.localeCompare(b));
  if (viaSchemas.length) notes.push(`schema ${atMost(viaSchemas, 3)}`);
  // Schemas compare one by one, so a name some other schema already had still counts where it is new.
  // The tool's inline input also compares against the schemas it pointed to: inlining one adds no fields.
  const fields = union(
    newFields(
      propertyNames(old.inputSchema, ...oldReach.map((s) => schemasBefore[s])),
      propertyNames(tool.inputSchema)
    ),
    ...viaSchemas.map((s) =>
      schemasBefore[s] && schemasAfter[s]
        ? newFields(propertyNames(schemasBefore[s]), propertyNames(schemasAfter[s]))
        : []
    )
  );
  if (notes.length) changed.push({ name, notes, schemas: viaSchemas, fields });
}
// Changed schemas no tool reaches by name (inlined into a tool, or only served by get_schema).
const orphanSchemas = changedSchemas.filter((s) => !changed.some((c) => c.schemas.includes(s)));

const newOps = minus(keys(opsAfter), keys(opsBefore));
const goneOps = minus(keys(opsBefore), keys(opsAfter));
const toolOps = new Set([...after.values()].map((t) => t.operationId));
const untoolOps = (ids) => ids.filter((id) => !toolOps.has(id));

function title() {
  if (!added.length && !removed.length && !changed.length && !orphanSchemas.length) {
    const ops = untoolOps(newOps).length;
    return `chore: sync openapi.yaml${ops ? ` (${ops} new operations not exposed as tools)` : ''}`;
  }
  // New fields that reach the most tools come first.
  const reach = new Map();
  for (const c of changed) for (const f of c.fields) reach.set(f, (reach.get(f) ?? 0) + 1);
  const fields = [...reach.keys()].sort((a, b) => reach.get(b) - reach.get(a));
  const rest = changed.filter((c) => !c.fields.length).map((c) => c.name);
  const type = added.length || fields.length ? 'feat' : 'fix';
  // `max` = how many names a phrase spells out before the rest becomes "and N more"
  const phrase = (verb, noun, names, max) => {
    const nouns = names.length === 1 ? noun : `${noun}s`;
    return max ? `${verb} ${nouns} ${atMost(names, max)}` : `${verb} ${names.length} ${nouns}`;
  };
  const render = (max) =>
    [
      added.length && phrase('add', 'tool', added, max),
      removed.length && phrase('remove', 'tool', removed, max),
      fields.length && phrase('add', 'field', fields, max),
      rest.length && phrase('update', 'tool', rest, max)
    ]
      .filter(Boolean)
      .join('; ') || phrase('update', 'schema', orphanSchemas, max);
  for (const max of [3, 2, 1, 0]) {
    const t = `${type}: ${render(max)}`;
    if (t.length <= 100 || max === 0) return t;
  }
}

const code = (names) => names.map((n) => `\`${n}\``).join(', ');
const lines = ['The live openapi.yaml changed; the tools have been regenerated.', ''];
if (added.length) lines.push(`**Added tools:** ${code(added)}`, '');
if (removed.length) lines.push(`**Removed tools:** ${code(removed)}`, '');
if (changed.length) {
  lines.push('**Changed tools:**');
  for (const c of changed)
    lines.push(`- \`${c.name}\`: ${c.notes.join('; ')}${c.fields.length ? ` (new fields: ${code(c.fields)})` : ''}`);
  lines.push('');
}
if (changedSchemas.length) lines.push(`**Changed schemas:** ${code(changedSchemas)}`, '');
if (untoolOps(newOps).length) lines.push(`**New operations not exposed as tools:** ${code(untoolOps(newOps))}`, '');
if (goneOps.length) lines.push(`**Removed operations:** ${code(goneOps)}`, '');
lines.push(`Tools: ${after.size}${after.size === before.size ? '' : ` (was ${before.size})`}`, '');
const stat = git('diff', '--stat', base, ...(head ? [head] : []), '--', 'spec', 'src/generated');
lines.push('```', stat.trimEnd(), '```');

const summary = { title: title(), body: lines.join('\n') };
if (process.env.GITHUB_OUTPUT) {
  for (const [k, v] of Object.entries(summary)) {
    const eof = `EOF_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<${eof}\n${v}\n${eof}\n`);
  }
}
console.log(`${summary.title}\n\n${summary.body}`);
