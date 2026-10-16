// Fetches the live openapi.yaml into spec/openapi.yaml. Used by the spec-sync workflow and `npm run spec:update`.
import { writeFileSync } from 'node:fs';

const url = process.env.JINSHUJU_OPENAPI_URL ?? 'https://jinshuju.net/api/v1/openapi.yaml';
const res = await fetch(url, { headers: { Accept: 'application/yaml, text/yaml, */*' } });
if (!res.ok) {
  console.error(`fetch ${url} -> ${res.status}`);
  process.exit(1);
}
const text = await res.text();
if (!text.startsWith('openapi:')) {
  console.error('unexpected content (not an OpenAPI document)');
  process.exit(1);
}
writeFileSync(new URL('../spec/openapi.yaml', import.meta.url), text);
console.log(`spec/openapi.yaml updated (${text.length} bytes, etag ${res.headers.get('etag') ?? '-'})`);
