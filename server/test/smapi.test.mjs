import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockSmapi } from './mock-smapi.mjs';
import { SmapiClient, SmapiError, accountsFromUris } from '../dist/testkit.js';

async function fixture(t, auth = 'AppLink', token = null, onToken) {
  const server = new MockSmapi();
  await server.start();
  t.after(() => server.stop());
  const client = new SmapiClient(
    { sid: 210, name: 'Test Music', uri: server.url, auth, sn: 2, capabilities: 2 },
    'household', 'device', token, onToken,
  );
  return { server, client };
}

for (const auth of ['AppLink', 'DeviceLink']) {
  test(`${auth} preserves private device proof and omits old credentials`, async (t) => {
    const { server, client } = await fixture(t, auth);
    server.linkDeviceId = 'proof<&>';
    server.pollsBeforeLink = 0;
    const link = await client.beginLink();
    assert.equal(link.linkDeviceId, 'proof<&>');
    assert.equal('linkDeviceId' in link.prompt, false);
    // Mock compares XML text; inspect the escaped request separately.
    server.linkDeviceId = 'proof&lt;&amp;&gt;';
    await client.finishLink(link.linkCode, link.linkDeviceId);
    const request = server.calls.at(-1);
    assert.match(request.body, /<linkDeviceId>proof&lt;&amp;&gt;<\/linkDeviceId>/);
    assert.equal(request.hasToken, false);
    if (auth === 'AppLink') {
      assert.match(server.calls[0].body, /<sonosAppName>Navigator Panel<\/sonosAppName>/);
      assert.doesNotMatch(server.calls[0].body, /<sn>/);
    }
  });
}

test('HTTP 200 SOAP faults preserve pending state and fault codes', async (t) => {
  const { server, client } = await fixture(t);
  server.faultStatus = 200;
  server.faults.getDeviceAuthToken = { code: 'Client.NOT_LINKED_RETRY', detail: '<ExceptionDetail>waiting</ExceptionDetail>' };
  await assert.rejects(() => client.finishLink('code'), (err) => err instanceof SmapiError && err.pending);
});

test('standard AuthTokenExpired faults request reauthorization', async (t) => {
  const { server, client } = await fixture(t);
  server.faults.getMetadata = { code: 'Client.AuthTokenExpired' };
  await assert.rejects(() => client.getMetadata('root'), (err) => err.expired);
});

test('refreshes credentials from a SOAP fault and retries the original browse once', async (t) => {
  const saved = [];
  const { server, client } = await fixture(t, 'AppLink', { token: 'old', key: 'old-key', sn: 2 }, async (token) => saved.push(token));
  server.faults.getMetadata = {
    code: 's:Client.TokenRefreshRequired', once: true,
    detail: '<refreshAuthTokenResult><authToken>new</authToken><privateKey>new-key</privateKey></refreshAuthTokenResult>',
  };
  assert.equal((await client.getMetadata('root')).items.length, 2);
  assert.deepEqual(saved, [{ token: 'new', key: 'new-key', sn: 2 }]);
  assert.equal(server.calls.length, 2);
  assert.match(server.calls[1].body, /<token>new<\/token>/);
});

test('a repeated refresh fault cannot loop indefinitely', async (t) => {
  const { server, client } = await fixture(t, 'AppLink', { token: 'old', key: 'key', sn: 2 });
  server.faults.getMetadata = {
    code: 'Client.TokenRefreshRequired',
    detail: '<refreshAuthTokenResult><authToken>new</authToken><privateKey>key</privateKey></refreshAuthTokenResult>',
  };
  await assert.rejects(() => client.getMetadata('root'), SmapiError);
  assert.equal(server.calls.length, 2);
});

test('an HTML success response is an error rather than an empty catalog', async (t) => {
  const { server, client } = await fixture(t);
  server.rawResponse = '<html><body>Sign in</body></html>';
  await assert.rejects(() => client.getMetadata('root'), /unreadable/);
});

test('AppLink uses authorization fields even if create-account fields come first', async (t) => {
  const { server, client } = await fixture(t);
  server.rawResponse = '<Envelope><Body><getAppLinkResponse><getAppLinkResult>' +
    '<createAccount><deviceLink><regUrl>https://wrong.invalid</regUrl><linkCode>wrong</linkCode></deviceLink></createAccount>' +
    '<authorizeAccount><deviceLink><regUrl>https://right.invalid</regUrl><linkCode>right</linkCode><showLinkCode>0</showLinkCode></deviceLink></authorizeAccount>' +
    '</getAppLinkResult></getAppLinkResponse></Body></Envelope>';
  const result = await client.beginLink();
  assert.equal(result.prompt.url, 'https://right.invalid');
  assert.equal(result.linkCode, 'right');
  assert.equal(result.prompt.code, null);
});

test('service discovery reads account numbers before sid and through nested escaping', () => {
  const found = accountsFromUris('<res>x-sonos-http:track?sn=7&amp;amp;sid=210&amp;amp;flags=32</res><res>x-sonos-http:other?sid=9&amp;sn=3</res>');
  assert.deepEqual([...found], [[210, 7], [9, 3]]);
});
