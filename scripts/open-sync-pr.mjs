// Opens the spec-sync pull request on Gitea, or refreshes the open one: the working tree goes onto the
// chore/sync-openapi branch, rebuilt from the base branch every run so the pull request always carries exactly the
// current diff, under the title and body from sync-summary.mjs. Replaces peter-evans/create-pull-request, which
// only speaks GitHub's API.
//
// Usage, in a Gitea Actions job after `npm run spec:update`:
//   GITEA_TOKEN=… PR_TITLE=… PR_BODY=… node scripts/open-sync-pr.mjs
// The base branch is the job's GITHUB_REF_NAME. Does nothing when the working tree is clean.
import { git, gitea, required } from './gitea.mjs';

if (!git(['status', '--porcelain']).trim()) {
  console.log('openapi.yaml is unchanged; nothing to open.');
  process.exit(0);
}

console.log(
  await gitea().upsertPullRequest({
    branch: 'chore/sync-openapi',
    base: required('GITHUB_REF_NAME'),
    title: required('PR_TITLE'),
    body: process.env.PR_BODY ?? '',
    label: 'openapi-sync'
  })
);
