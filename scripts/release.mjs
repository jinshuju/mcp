// Moves the version along, as release-please did before the move to Gitea. On every push to main:
//   1. When package.json names a version that has no tag, the release pull request has just been merged: HEAD is
//      tagged vX.Y.Z and a Gitea release carries that version's CHANGELOG section. GitHub's release.yml publishes the
//      tag to npm once the mirror has it.
//   2. The conventional commits since the last tag give the next version (bump-minor-pre-major: a breaking change or a
//      feat bumps the minor, anything else the patch, while the major is 0) and the CHANGELOG section (feat, fix, perf
//      and revert; a `Release-As: X.Y.Z` footer sets the version). CHANGELOG.md, package.json, package-lock.json and
//      src/version.ts are written and the release pull request `chore(main): release X.Y.Z` is opened on the
//      chore/release branch, or refreshed. Commits that are not conventional commits are ignored, so `#T17067 feat: …`
//      never releases: put the ticket in a footer.
//
// Usage, in a Gitea Actions job: GITEA_TOKEN=… node scripts/release.mjs
//   node scripts/release.mjs --dry-run   prints what the run would do without touching anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { git, gitea, required } from './gitea.mjs';

const BRANCH = 'chore/release';
// Headings by commit type, as release-please-config.json had them; other types bump the patch version but are not listed.
const SECTIONS = { feat: 'Features', fix: 'Fixes', perf: 'Performance', revert: 'Reverts' };
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const dryRun = process.argv.includes('--dry-run');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// Links point at the public GitHub mirror, as the earlier CHANGELOG entries do.
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const current = pkg.version;
const tagOf = (version) => `v${version}`;
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const g = dryRun ? undefined : gitea();

/** Whether the version's tag exists; in a job the tag is also fetched, so git log can start from it. */
async function released(version) {
  const local = () => git(['tag', '--list', tagOf(version)]).trim() !== '';
  if (dryRun) return local();
  const tag = await g.api('GET', `/repos/${g.repo}/tags/${tagOf(version)}`);
  if (tag && !local()) g.fetchRef(`refs/tags/${tagOf(version)}:refs/tags/${tagOf(version)}`);
  return tag !== undefined;
}

/** The `## [version]…` section of CHANGELOG.md, heading included. */
function section(version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`) || l.startsWith(`## ${version} `));
  if (start < 0) return '';
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start, next < 0 ? lines.length : next)
    .join('\n')
    .trim();
}

// 1. Tag the version the merged release pull request set.
if (!(await released(current))) {
  const sha = git(['rev-parse', 'HEAD']).trim();
  const notes = section(current).split('\n').slice(1).join('\n').trim();
  if (dryRun) {
    console.log(`Would tag ${sha.slice(0, 7)} as ${tagOf(current)} and release it with:\n${notes}\n`);
    process.exit(0); // nothing lands after the tag
  } else {
    git(['tag', tagOf(current), sha]);
    g.push(`refs/tags/${tagOf(current)}`);
    await g.api('POST', `/repos/${g.repo}/releases`, {
      tag_name: tagOf(current),
      target_commitish: sha,
      name: tagOf(current),
      body: notes
    });
    console.log(`Tagged ${sha.slice(0, 7)} as ${tagOf(current)} and published its release`);
  }
}

// 2. Open or refresh the release pull request for what landed since.
function parse(entry) {
  const [sha, subject, body = ''] = entry.split('\0');
  const m = subject.match(HEADER);
  if (!m) return undefined; // not a conventional commit: ignored, as release-please did
  const type = m[1].toLowerCase() === 'feature' ? 'feat' : m[1].toLowerCase();
  const breakingNote = body.match(/^BREAKING[ -]CHANGE: (.+)$/m)?.[1];
  return {
    sha,
    type,
    scope: m[2],
    subject: m[4],
    breaking: m[3] === '!' || breakingNote !== undefined,
    breakingNote,
    releaseAs: body.match(/^Release-As: v?(\d+\.\d+\.\d+)$/im)?.[1]
  };
}
const commits = git(['log', '--no-merges', '--format=%H%x00%s%x00%b%x1e', `${tagOf(current)}..HEAD`])
  .split('\x1e')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map(parse)
  .filter(Boolean);

const releaseAs = commits.find((c) => c.releaseAs)?.releaseAs; // newest first
if (!releaseAs && !commits.some((c) => c.breaking || Object.hasOwn(SECTIONS, c.type))) {
  console.log(`Nothing to release since ${tagOf(current)}.`);
  process.exit(0);
}

function bump(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  const breaking = commits.some((c) => c.breaking);
  if (breaking && major > 0) return `${major + 1}.0.0`;
  if (breaking || commits.some((c) => c.type === 'feat')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
const version = releaseAs ?? bump(current);

function notes() {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## [${version}](${repoUrl}/compare/${tagOf(current)}...${tagOf(version)}) (${date})`];
  const sorted = (list) =>
    list.sort((a, b) => (a.scope ?? '').localeCompare(b.scope ?? '') || a.subject.localeCompare(b.subject));
  const bullet = (c, text) => `* ${c.scope ? `**${c.scope}:** ` : ''}${text}`;
  const breaking = sorted(commits.filter((c) => c.breaking));
  if (breaking.length) {
    lines.push('', '', '### ⚠ BREAKING CHANGES', '', ...breaking.map((c) => bullet(c, c.breakingNote ?? c.subject)));
  }
  for (const [type, heading] of Object.entries(SECTIONS)) {
    const list = sorted(commits.filter((c) => c.type === type));
    if (!list.length) continue;
    const link = (c) => `${c.subject} ([${c.sha.slice(0, 7)}](${repoUrl}/commit/${c.sha}))`;
    lines.push('', '', `### ${heading}`, '', ...list.map((c) => bullet(c, link(c))));
  }
  return lines.join('\n') + '\n';
}
const entry = notes();
const title = `chore(main): release ${version}`;

if (dryRun) {
  console.log(`Would open "${title}" with:\n\n${entry}`);
  process.exit(0);
}

const json = (file, edit) => {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};
json('package.json', (p) => (p.version = version));
json('package-lock.json', (l) => (l.version = l.packages[''].version = version));
writeFileSync(
  'src/version.ts',
  readFileSync('src/version.ts', 'utf8').replace(/'[^']*'(?=.*\/\/ x-release-version)/, `'${version}'`)
);
const lines = changelog.split('\n');
const at = lines.findIndex((l) => l.startsWith('## '));
lines.splice(at < 0 ? lines.length : at, 0, ...entry.split('\n'));
writeFileSync('CHANGELOG.md', lines.join('\n'));

console.log(
  await g.upsertPullRequest({
    branch: BRANCH,
    base: required('GITHUB_REF_NAME'),
    title,
    body: `:robot: Merging this pull request tags ${tagOf(version)}; GitHub then publishes it to npm.\n\n${entry}`
  })
);
