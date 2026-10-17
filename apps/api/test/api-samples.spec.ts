import { describe, expect, it } from 'vitest';
import {
  CODE_SAMPLE_LANGS,
  apiServerOptions,
  codeSamplesFor,
  exampleForSchema,
  operationAuth,
  resolveSampleRequest,
  renderCodeSample,
  sampleRequestFor,
  specCodeSamples,
} from '@knowledge/contracts';

/** Code samples (#78, phase 4): one request model, one printer per language. */

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Billing', version: '1' },
  servers: [
    {
      url: 'https://{region}.api.example.com/v1/',
      variables: { region: { default: 'eu', enum: ['eu', 'us'] }, unused: { default: 'x' } },
    },
    { url: 'https://{tenant}.example.com', variables: { tenant: { default: 'acme' } } },
  ],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      key: { type: 'apiKey', in: 'query', name: 'api_key' },
      basic: { type: 'http', scheme: 'basic' },
    },
    schemas: {
      Invoice: {
        type: 'object',
        required: ['amount'],
        properties: {
          id: { type: 'string', readOnly: true },
          amount: { type: 'integer', example: 100 },
          note: { type: 'string' },
          due: { type: 'string', format: 'date' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } },
        },
      },
      Line: { type: 'object', properties: { sku: { type: 'string', example: 'A-1' }, parent: { $ref: '#/components/schemas/Line' } } },
    },
  },
  paths: {
    '/invoices/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'inv_1' }],
      post: {
        parameters: [
          { name: 'expand', in: 'query', required: true, schema: { type: 'string', enum: ['lines'] } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string', example: 'r-1' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } },
        responses: { '201': { description: 'Created' } },
      },
      get: {
        security: [{ key: [] }],
        responses: { '200': { description: 'OK' } },
        'x-codeSamples': [
          { lang: 'cURL', label: 'Shell', source: 'curl https://eu.api.example.com/v1/invoices/inv_1' },
          { lang: 'Python', source: 'print("hand written")' },
          { lang: 'Python', source: 'print("second, ignored")' },
          { lang: 'Rust', source: 'fn main() {}' },
        ],
      },
      delete: { security: [{ basic: [] }], responses: { '204': { description: 'Gone' } } },
    },
  },
};

const POST = { method: 'POST', path: '/invoices/{id}', pointer: '/paths/~1invoices~1{id}/post' };
const GET = { method: 'GET', path: '/invoices/{id}', pointer: '/paths/~1invoices~1{id}/get' };
const DELETE = { method: 'DELETE', path: '/invoices/{id}', pointer: '/paths/~1invoices~1{id}/delete' };

describe('apiServerOptions', () => {
  it('expands enum variables, and takes only the default of a free-form one', () => {
    expect(apiServerOptions(SPEC).map((s) => s.url)).toEqual([
      'https://eu.api.example.com/v1/',
      'https://us.api.example.com/v1/',
      'https://acme.example.com',
    ]);
  });

  it('is empty for a spec with no servers', () => {
    expect(apiServerOptions({ openapi: '3.1.0' })).toEqual([]);
  });
});

describe('exampleForSchema', () => {
  it('builds a body from a schema, skipping readOnly fields and stopping at recursion', () => {
    expect(exampleForSchema(SPEC, { $ref: '#/components/schemas/Invoice' })).toEqual({
      amount: 100,
      note: 'string',
      due: '2026-01-01',
      lines: [{ sku: 'A-1', parent: null }],
    });
  });
});

describe('sampleRequestFor', () => {
  it('fills path, required query and header params from examples, and auth with a placeholder', () => {
    const req = sampleRequestFor(SPEC, POST)!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://eu.api.example.com/v1/invoices/inv_1');
    expect(req.query).toEqual([{ name: 'expand', value: ['lines'] }]);
    expect(req.headers).toEqual([
      { name: 'X-Request-Id', value: ['r-1'] },
      { name: 'Content-Type', value: ['application/json'] },
      { name: 'Authorization', value: ['Bearer ', { env: 'TOKEN' }] },
    ]);
  });

  it('takes the console values, and never a credential', () => {
    const req = sampleRequestFor(SPEC, POST, {
      serverUrl: 'https://us.api.example.com/v1',
      path: { id: 'inv 2' },
      query: { expand: 'lines', page: '3' },
      headers: { 'X-Request-Id': 'abc' },
      body: '{"amount": 5}',
    })!;
    expect(req.url).toBe('https://us.api.example.com/v1/invoices/inv%202');
    expect(req.query.map((q) => q.name)).toEqual(['expand', 'page']);
    expect(req.body).toEqual({ contentType: 'application/json', text: '{\n  "amount": 5\n}', json: { amount: 5 } });
    expect(JSON.stringify(req.headers)).toContain('{"env":"TOKEN"}');
  });

  it('keeps an unparseable JSON body as typed', () => {
    expect(sampleRequestFor(SPEC, POST, { body: '{"amount":' })!.body).toEqual({ contentType: 'application/json', text: '{"amount":' });
  });

  it('is null for an AsyncAPI operation', () => {
    expect(sampleRequestFor(SPEC, { ...POST, protocol: 'async' })).toBeNull();
  });
});

describe('printers', () => {
  const req = sampleRequestFor(SPEC, POST)!;

  it('curl: single quotes, except where a placeholder must expand', () => {
    expect(renderCodeSample('curl', req)).toMatchInlineSnapshot(`
      "curl --request POST \\
        --url 'https://eu.api.example.com/v1/invoices/inv_1?expand=lines' \\
        --header 'X-Request-Id: r-1' \\
        --header 'Content-Type: application/json' \\
        --header "Authorization: Bearer $TOKEN" \\
        --data '{
        "amount": 100,
        "note": "string",
        "due": "2026-01-01",
        "lines": [
          {
            "sku": "A-1",
            "parent": null
          }
        ]
      }'"
    `);
  });

  it('javascript: fetch, with the placeholder read from process.env', () => {
    expect(renderCodeSample('javascript', req)).toMatchInlineSnapshot(`
      "const response = await fetch("https://eu.api.example.com/v1/invoices/inv_1?expand=lines", {
        method: "POST",
        headers: {
          "X-Request-Id": "r-1",
          "Content-Type": "application/json",
          "Authorization": \`Bearer \${process.env.TOKEN}\`,
        },
        body: JSON.stringify({
          "amount": 100,
          "note": "string",
          "due": "2026-01-01",
          "lines": [
            {
              "sku": "A-1",
              "parent": null
            }
          ]
        }),
      });

      console.log(response.status, await response.text());"
    `);
  });

  it('python: requests, with Python literals and os.environ', () => {
    expect(renderCodeSample('python', req)).toMatchInlineSnapshot(`
      "import os

      import requests

      response = requests.request(
          "POST",
          "https://eu.api.example.com/v1/invoices/inv_1",
          params={
              "expand": "lines",
          },
          headers={
              "X-Request-Id": "r-1",
              "Content-Type": "application/json",
              "Authorization": f"Bearer {os.environ['TOKEN']}",
          },
          json={
              "amount": 100,
              "note": "string",
              "due": "2026-01-01",
              "lines": [
                  {
                      "sku": "A-1",
                      "parent": None,
                  },
              ],
          },
      )

      print(response.status_code, response.text)"
    `);
  });

  it('go: net/http, importing only what it uses', () => {
    expect(renderCodeSample('go', req)).toMatchInlineSnapshot(`
      "package main

      import (
      	"fmt"
      	"io"
      	"net/http"
      	"os"
      	"strings"
      )

      func main() {
      	body := strings.NewReader(\`{
        "amount": 100,
        "note": "string",
        "due": "2026-01-01",
        "lines": [
          {
            "sku": "A-1",
            "parent": null
          }
        ]
      }\`)
      	req, err := http.NewRequest("POST", "https://eu.api.example.com/v1/invoices/inv_1?expand=lines", body)
      	if err != nil {
      		panic(err)
      	}
      	req.Header.Set("X-Request-Id", "r-1")
      	req.Header.Set("Content-Type", "application/json")
      	req.Header.Set("Authorization", "Bearer " + os.Getenv("TOKEN"))

      	res, err := http.DefaultClient.Do(req)
      	if err != nil {
      		panic(err)
      	}
      	defer res.Body.Close()

      	out, _ := io.ReadAll(res.Body)
      	fmt.Println(res.Status, string(out))
      }"
    `);
  });

  it('a query-string API key is a placeholder in every language', () => {
    const del = { ...GET, pointer: '/paths/~1invoices~1{id}/get' };
    const r = sampleRequestFor(SPEC, del)!;
    expect(r.query).toEqual([{ name: 'api_key', value: [{ env: 'API_KEY' }] }]);
    expect(renderCodeSample('curl', r)).toContain(`--url "https://eu.api.example.com/v1/invoices/inv_1?api_key=$API_KEY"`);
    expect(renderCodeSample('javascript', r)).toContain('`https://eu.api.example.com/v1/invoices/inv_1?api_key=${process.env.API_KEY}`');
    expect(renderCodeSample('python', r)).toContain(`"api_key": f"{os.environ['API_KEY']}"`);
    expect(renderCodeSample('go', r)).toContain('"https://eu.api.example.com/v1/invoices/inv_1?api_key=" + os.Getenv("API_KEY")');
  });

  it('basic auth reads one credentials variable, and a body-less request imports nothing for it', () => {
    const r = sampleRequestFor(SPEC, DELETE)!;
    expect(r.body).toBeNull();
    expect(renderCodeSample('curl', r)).toContain(`"Authorization: Basic $BASIC_CREDENTIALS"`);
    expect(renderCodeSample('go', r)).not.toContain('"strings"');
    expect(renderCodeSample('go', r)).toContain('http.NewRequest("DELETE", "https://eu.api.example.com/v1/invoices/inv_1", nil)');
  });

  it('escapes what each language would otherwise read', () => {
    const r = { method: 'POST', url: 'https://x.test/a', query: [], headers: [{ name: 'X', value: [`it's`] }], body: { contentType: 'text/plain', text: 'a `b` ${c} $D "e"' } };
    expect(renderCodeSample('curl', r)).toContain(`--header 'X: it'\\''s'`);
    expect(renderCodeSample('javascript', r)).toContain(`body: "a \`b\` \${c} $D \\"e\\""`);
    expect(renderCodeSample('go', r)).toContain('strings.NewReader("a `b` ${c} $D \\"e\\"")');
  });
});

describe('x-codeSamples', () => {
  it('folds spec language names onto ours, first per language wins, unknown ones are ignored', () => {
    const own = specCodeSamples(SPEC.paths['/invoices/{id}'].get);
    expect(own).toEqual({
      curl: { source: 'curl https://eu.api.example.com/v1/invoices/inv_1', label: 'Shell' },
      python: { source: 'print("hand written")', label: null },
    });
  });

  it("takes the author's sample per language and generates the rest", () => {
    const samples = codeSamplesFor(SPEC, GET);
    expect(samples.map((s) => [s.lang, s.origin])).toEqual([
      ['curl', 'spec'],
      ['javascript', 'generated'],
      ['python', 'spec'],
      ['go', 'generated'],
    ]);
    expect(samples.map((s) => s.lang)).toEqual([...CODE_SAMPLE_LANGS]);
  });

  it('reads the older x-code-samples spelling too', () => {
    expect(specCodeSamples({ 'x-code-samples': [{ lang: 'go', source: 'package main' }] })).toEqual({
      go: { source: 'package main', label: null },
    });
  });
});

describe('operationAuth / resolveSampleRequest', () => {
  it("names each scheme's slot, and the console fills it in only at send time", () => {
    expect(operationAuth(SPEC, GET)).toEqual([{ scheme: 'key', kind: 'apiKey', in: 'query', name: 'api_key', env: 'API_KEY' }]);
    const req = sampleRequestFor(SPEC, POST)!;
    expect(resolveSampleRequest(req, { TOKEN: 'secret' })).toMatchObject({
      url: 'https://eu.api.example.com/v1/invoices/inv_1?expand=lines',
      headers: expect.arrayContaining([{ name: 'Authorization', value: 'Bearer secret' }]),
    });
    // No token: the header is left out, not sent as "Bearer ".
    expect(resolveSampleRequest(req, {}).headers.map((h) => h.name)).toEqual(['X-Request-Id', 'Content-Type']);
    expect(resolveSampleRequest(sampleRequestFor(SPEC, GET)!, { API_KEY: 'k 1' }).url).toBe(
      'https://eu.api.example.com/v1/invoices/inv_1?api_key=k%201',
    );
  });
});
