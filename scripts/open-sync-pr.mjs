// Opens the spec-sync pull request on Gitea, or refreshes the open one: commits the working tree to the
// chore/sync-openapi branch (rebuilt from the base branch every run, so the pull request always carries exactly the
// current diff), force-pushes it with the job token, then creates the pull request with the title and body from
// sync-summary.mjs, or updates them on the pull request already open for the branch.
// Replaces peter-evans/create-pull-request, which only speaks GitHub's API.
//
// Usage, in a Gitea Actions job after `npm run spec:update`:
//   GITEA_TOKEN=… PR_TITLE=… PR_BODY=… node scripts/open-sync-pr.mjs
// The job's GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_REF_NAME (the base branch) are read as well.
// Does nothing when the working tree is clean.
import { execFileSync } from 'node:child_process';

const BRANCH = 'chore/sync-openapi';
const LABEL = 'openapi-sync';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const git = (args, options = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });

if (!git(['status', '--porcelain']).trim()) {
  console.log('openapi.yaml is unchanged; nothing to open.');
  process.exit(0);
}

const token = env('GITEA_TOKEN');
const server = env('GITHUB_SERVER_URL').replace(/\/$/, '');
const repo = env('GITHUB_REPOSITORY');
const base = env('GITHUB_REF_NAME');
const title = env('PR_TITLE');
const body = process.env.PR_BODY ?? '';

git(['config', 'user.name', 'gitea-actions[bot]']);
git(['config', 'user.email', `gitea-actions[bot]@noreply.${new URL(server).host}`]);
git(['checkout', '--quiet', '-B', BRANCH]);
git(['add', '--all']);
git(['commit', '--quiet', '--message', title]);
// The token travels in a header, as builtin:checkout sends it, and stays off the command line.
const auth = Buffer.from(`token:${token}`).toString('base64');
git(['push', '--force', `${server}/${repo}.git`, `HEAD:refs/heads/${BRANCH}`], {
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`
  }
});

/** Calls the Gitea API; a GET that finds nothing resolves to undefined. */
async function api(method, path, data) {
  const res = await fetch(`${server}/api/v1${path}`, {
    method,
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  if (res.status === 404 && method === 'GET') return undefined;
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
}

// Only an open, unmerged pull request is found by base and head.
const open = await api('GET', `/repos/${repo}/pulls/${base}/${BRANCH}`);
if (open) {
  await api('PATCH', `/repos/${repo}/pulls/${open.number}`, { title, body });
  console.log(`Updated ${open.html_url}`);
} else {
  const labels = (await api('GET', `/repos/${repo}/labels?limit=100`)) ?? [];
  const label =
    labels.find((l) => l.name === LABEL) ??
    (await api('POST', `/repos/${repo}/labels`, { name: LABEL, color: '#0e8a16' }));
  const pr = await api('POST', `/repos/${repo}/pulls`, { head: BRANCH, base, title, body, labels: [label.id] });
  console.log(`Opened ${pr.html_url}`);
}
