// Moves the version along, as release-please did before the move to Gitea. On every push to main:
//   1. When package.json names a version that has no tag, the release pull request has just been merged: HEAD is
//      tagged vX.Y.Z and a Gitea release carries that version's CHANGELOG section. GitHub's release.yml publishes the
//      tag to npm once the mirror has it.
//   2. The conventional commits since the last tag give the next version (a breaking change bumps the major once it
//      is past 0, anything else the minor; the patch belongs to the deploys, see 3) and the CHANGELOG section (feat,
//      fix, perf and revert; a `Release-As: X.Y.Z` footer sets the version). CHANGELOG.md, package.json,
//      package-lock.json and src/version.ts are written and the release pull request `chore(main): release X.Y.0` is
//      opened on the chore/release branch, or refreshed. Commits that are not conventional commits are ignored, so
//      `#T17067 feat: …` never releases: put the ticket in a footer.
//   3. The commits since src/version.ts last changed are what main has beyond its last deploy. They are listed in the
//      deploy pull request `chore(main): deploy X.Y.Z` on the chore/deploy branch, opened or refreshed, which moves
//      only the patch in src/version.ts: merging it deploys main (deploy.yml triggers on that file) under a version no
//      other deploy has, and tags and publishes nothing, so package.json keeps the version that is on npm. When main
//      is deployed as it is, the pull request is closed instead.
//   Both pull requests change the same line, so merging one leaves the other in conflict until that push rebuilds it.
//
// Usage, in a Gitea Actions job: GITEA_TOKEN=… node scripts/release.mjs
//   node scripts/release.mjs --dry-run   prints what the run would do without touching anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { git, gitea, required } from './gitea.mjs';

const RELEASE_BRANCH = 'chore/release';
const DEPLOY_BRANCH = 'chore/deploy';
const VERSION_FILE = 'src/version.ts';
// The version in src/version.ts: the string on the line marked `// x-release-version`.
const VERSION_IN_FILE = /'([^']*)'(?=.*\/\/ x-release-version)/;
// Headings by commit type, as release-please-config.json had them; other types are not listed and release nothing
// on their own.
const SECTIONS = { feat: 'Features', fix: 'Fixes', perf: 'Performance', revert: 'Reverts' };
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const dryRun = process.argv.includes('--dry-run');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// Links point at the public GitHub mirror, as the earlier CHANGELOG entries do.
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const current = pkg.version;
const deployed = readFileSync(VERSION_FILE, 'utf8').match(VERSION_IN_FILE)[1];
const tagOf = (version) => `v${version}`;
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const head = git(['rev-parse', 'HEAD']).trim();
const g = dryRun ? undefined : gitea();
const base = () => required('GITHUB_REF_NAME');

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
  const notes = section(current).split('\n').slice(1).join('\n').trim();
  if (dryRun) {
    console.log(`Would tag ${head.slice(0, 7)} as ${tagOf(current)} and release it with:\n${notes}\n`);
    process.exit(0); // nothing lands after the tag
  } else {
    git(['tag', tagOf(current), head]);
    g.push(`refs/tags/${tagOf(current)}`);
    await g.api('POST', `/repos/${g.repo}/releases`, {
      tag_name: tagOf(current),
      target_commitish: head,
      name: tagOf(current),
      body: notes
    });
    console.log(`Tagged ${head.slice(0, 7)} as ${tagOf(current)} and published its release`);
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

/** A breaking change bumps the major once it is past 0, anything else the minor; the patch is the deploys' (see 3). */
function bump(version) {
  const [major, minor] = version.split('.').map(Number);
  if (major > 0 && commits.some((c) => c.breaking)) return `${major + 1}.0.0`;
  return `${major}.${minor + 1}.0`;
}

function notes(version) {
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

const json = (file, edit) => {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};
const writeVersion = (version) =>
  writeFileSync(VERSION_FILE, readFileSync(VERSION_FILE, 'utf8').replace(VERSION_IN_FILE, `'${version}'`));

async function releasePullRequest() {
  if (!releaseAs && !commits.some((c) => c.breaking || Object.hasOwn(SECTIONS, c.type))) {
    console.log(`Nothing to release since ${tagOf(current)}.`);
    return;
  }
  const version = releaseAs ?? bump(current);
  const entry = notes(version);
  const title = `chore(main): release ${version}`;
  if (dryRun) {
    console.log(`Would open "${title}" with:\n\n${entry}`);
    return;
  }
  json('package.json', (p) => (p.version = version));
  json('package-lock.json', (l) => (l.version = l.packages[''].version = version));
  writeVersion(version);
  const lines = changelog.split('\n');
  const at = lines.findIndex((l) => l.startsWith('## '));
  lines.splice(at < 0 ? lines.length : at, 0, ...entry.split('\n'));
  writeFileSync('CHANGELOG.md', lines.join('\n'));
  console.log(
    await g.upsertPullRequest({
      branch: RELEASE_BRANCH,
      base: base(),
      title,
      body: `:robot: Merging this pull request tags ${tagOf(version)}; GitHub then publishes it to npm.\n\n${entry}`
    })
  );
  // Back on the pushed commit, so the deploy branch is rebuilt from it as well.
  git(['checkout', '--quiet', '--detach', head]);
}
await releasePullRequest();

// 3. Open or refresh the deploy pull request for what landed since the version last changed, or close it.
async function deployPullRequest() {
  // Along the first parent: a merge commit is where main saw the file change, whichever side wrote it.
  const since = git(['log', '--first-parent', '-1', '--format=%H', '--', VERSION_FILE]).trim();
  const landed = git(['log', '--no-merges', '--format=* %s (%h)', `${since}..HEAD`]).trim();
  if (!landed) {
    const closed = dryRun ? undefined : await g.closePullRequest({ branch: DEPLOY_BRANCH, base: base() });
    console.log(closed ?? `Nothing to deploy since ${deployed} landed.`);
    return;
  }
  const [major, minor, patch] = deployed.split('.').map(Number);
  const version = `${major}.${minor}.${patch + 1}`;
  const title = `chore(main): deploy ${version}`;
  if (dryRun) {
    console.log(`Would open "${title}" with:\n\n${landed}\n`);
    return;
  }
  writeVersion(version);
  console.log(
    await g.upsertPullRequest({
      branch: DEPLOY_BRANCH,
      base: base(),
      title,
      body: `:robot: Merging this pull request deploys main as ${version} (deploy.yml); nothing is tagged or published.\n\n${landed}\n`,
      label: 'skip-code-review'
    })
  );
}
await deployPullRequest();
