'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatcher } = require('../src/whitelist');

const m = createMatcher([
  { host: 'exam.college.edu', ports: [443] },
  { host: '*.cdn.example.com', ports: [443] },
  { host: 'lab.college.edu', ports: [8080, 8443], schemes: ['http', 'https'] },
  { host: '10.1.2.3', ports: [3000], schemes: ['http'] },
  { host: '[::1]', ports: [9000], schemes: ['http'] },
]);
const ok = (u, o) => assert.equal(m.check(u, o).allowed, true, u + ' should be allowed');
const no = (u, cat, o) => {
  const r = m.check(u, o);
  assert.equal(r.allowed, false, u + ' should be blocked');
  if (cat) assert.equal(r.category, cat, `${u} category`);
};

test('allows whitelisted host on default port', () => {
  ok('https://exam.college.edu/quiz?id=1');
  ok('https://exam.college.edu:443/x');
  ok('wss://exam.college.edu/socket');
});

test('blocks other domains, including look-alikes and suffix tricks', () => {
  no('https://google.com/', 'domain');
  no('https://exam.college.edu.evil.com/', 'domain');
  no('https://evilexam.college.edu/', 'domain');
  no('https://exam.college.edu@evil.com/', 'domain');
  no('https://sub.exam.college.edu/', 'domain'); // no wildcard on this rule
});

test('wildcard matches subdomains but not the bare domain', () => {
  ok('https://a.cdn.example.com/x.js');
  ok('https://a.b.cdn.example.com/x.js');
  no('https://cdn.example.com/', 'domain');
  no('https://notcdn.example.com/', 'domain');
});

test('ports are enforced', () => {
  no('https://exam.college.edu:8443/', 'port');
  no('https://exam.college.edu:80/', 'port');
  ok('http://lab.college.edu:8080/');
  ok('https://lab.college.edu:8443/');
  no('http://lab.college.edu/', 'port'); // default port 80 not listed
  no('http://lab.college.edu:9999/', 'port');
});

test('schemes are enforced', () => {
  no('http://exam.college.edu/', 'scheme');
  no('ws://exam.college.edu/', 'scheme');
  ok('http://10.1.2.3:3000/');
  no('https://10.1.2.3:3000/', 'scheme');
});

test('IP literals only when whitelisted', () => {
  no('http://10.1.2.4:3000/', 'domain');
  no('http://127.0.0.1:3000/', 'domain');
  ok('http://[::1]:9000/');
  no('http://[::1]:9001/', 'port');
});

test('non-web protocols are blocked', () => {
  no('file:///etc/passwd', 'protocol');
  no('ftp://exam.college.edu/', 'protocol');
  no('chrome://gpu', 'protocol');
  no('view-source:https://exam.college.edu/', 'protocol');
  no('javascript:alert(1)', 'protocol');
  no('chrome-extension://abc/x.html', 'protocol');
  no('not a url', 'invalid');
});

test('data:/blob: only as subresources', () => {
  ok('data:image/png;base64,AAAA', { isFrame: false });
  no('data:text/html,<h1>x</h1>', 'protocol', { isFrame: true });
  ok('blob:https://exam.college.edu/1234', { isFrame: false });
  no('blob:https://evil.com/1234', 'domain', { isFrame: false });
  no('blob:https://exam.college.edu/1234', 'protocol', { isFrame: true });
});

test('about:blank ok, other about: pages blocked', () => {
  ok('about:blank');
  no('about:srcdoc', 'protocol');
});

test('case and trailing-dot normalisation', () => {
  ok('https://EXAM.College.EDU/');
  ok('https://exam.college.edu./');
});

test('empty or malformed rule lists deny everything', () => {
  for (const bad of [undefined, null, [], [{}], [{ host: 5 }], [{ host: '' }]]) {
    assert.equal(createMatcher(bad).check('https://exam.college.edu/').allowed, false);
  }
});
