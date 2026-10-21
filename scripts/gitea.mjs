// What the workflow scripts share about Gitea: the job's token, server and repository, its API, pushing with the
// token, and rebuilding a branch from the checkout to open or refresh its pull request (the spec-sync and release
// pull requests).
import { execFileSync } from 'node:child_process';

/** Runs git and returns its output; stderr goes to the job log. */
export const git = (args, options = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The job's view of Gitea, from GITEA_TOKEN, GITHUB_SERVER_URL and GITHUB_REPOSITORY. */
export function gitea() {
  const token = required('GITEA_TOKEN');
  const server = required('GITHUB_SERVER_URL').replace(/\/$/, '');
  const repo = required('GITHUB_REPOSITORY');
  const remote = `${server}/${repo}.git`;
  // The token travels in a header, as builtin:checkout sends it, and stays off the command line.
  const authEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`token:${token}`).toString('base64')}`
  };

  /** Calls the API; a GET that finds nothing resolves to undefined. */
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

  const push = (refspec, { force = false } = {}) =>
    git(['push', ...(force ? ['--force'] : []), remote, refspec], { env: authEnv });
  const fetchRef = (refspec) => git(['fetch', '--no-tags', remote, refspec], { env: authEnv });

  /** The label's id, creating the label when the repository lacks it; pull requests take labels by id. */
  async function labelId(name) {
    const labels = (await api('GET', `/repos/${repo}/labels?limit=100`)) ?? [];
    const label =
      labels.find((l) => l.name === name) ?? (await api('POST', `/repos/${repo}/labels`, { name, color: '#0e8a16' }));
    return label.id;
  }

  /**
   * Commits the working tree on `branch`, rebuilt from HEAD so it carries exactly this diff, force-pushes it and opens
   * the pull request against `base`, or refreshes the title and body of the one already open for the branch.
   */
  async function upsertPullRequest({ branch, base, title, body, label }) {
    git(['config', 'user.name', 'gitea-actions[bot]']);
    git(['config', 'user.email', `gitea-actions[bot]@noreply.${new URL(server).host}`]);
    git(['checkout', '--quiet', '-B', branch]);
    git(['add', '--all']);
    git(['commit', '--quiet', '--message', title]);
    push(`HEAD:refs/heads/${branch}`, { force: true });
    // Only an open, unmerged pull request is found by base and head.
    const open = await api('GET', `/repos/${repo}/pulls/${base}/${branch}`);
    if (open) {
      await api('PATCH', `/repos/${repo}/pulls/${open.number}`, { title, body });
      return `Updated ${open.html_url}`;
    }
    const labels = label ? [await labelId(label)] : [];
    const pr = await api('POST', `/repos/${repo}/pulls`, { head: branch, base, title, body, labels });
    return `Opened ${pr.html_url}`;
  }

  return { repo, api, push, fetchRef, upsertPullRequest };
}
