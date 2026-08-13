import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedIp } from '../src/index.js'
import { ipsEqual, normalizeIp } from '../src/ip.js'

const blocked = [
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.0.1',
  '127.0.0.1',
  '127.255.255.255',
  '169.254.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.0.8',
  '192.0.0.170',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.0.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '0:0:0:0:0:0:0:1',
  '[::1]',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::FFFF:7F00:1',
  '::ffff:a9fe:a9fe',
  '::ffff:10.0.0.1',
  '::ffff:0:7f00:1',
  '::ffff:0:127.0.0.1',
  '::ffff:0:a9fe:a9fe',
  '0:0:0:0:ffff:0:7f00:1',
  '::10.0.0.1',
  '::7f00:1',
  '64:ff9b::7f00:1',
  '64:ff9b:1::1',
  '100::1',
  '100:0:0:1::',
  '100:0:0:1::1',
  '100:0:0:1:ffff:ffff:ffff:ffff',
  '2001:0:4136:e378::',
  '2001:db8::1',
  '2002:7f00:1::1',
  '3fff::1',
  '3fff:fff::1',
  '5f00::1',
  'fc00::1',
  'fd12:3456:789a::1',
  'fe80::1',
  'fe80::1%eth0',
  'ff02::1',
]

const allowed = [
  '1.1.1.1',
  '8.8.8.8',
  '9.9.9.9',
  '11.0.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '126.0.0.1',
  '128.0.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.0.1.1',
  '192.88.98.255',
  '192.88.100.0',
  '199.0.0.1',
  '223.255.255.255',
  '100:0:0:2::1',
  '2001:4860:4860::8888',
  '2606:4700:4700::1111',
  '2a00:1450:4001::',
  '3fff:1000::1',
  '5f01::1',
  '::ffff:1.1.1.1',
  '::ffff:0808:0808',
  '::ffff:0:1.1.1.1',
  '::ffff:0:808:808',
  '64:ff9b::0808:0808',
  '2002:0808:0808::1',
]

test('blocks special-use and private IPv4/IPv6', () => {
  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, ip)
  }
})

test('allows public IPv4/IPv6', () => {
  for (const ip of allowed) {
    assert.equal(isBlockedIp(ip), false, ip)
  }
})

test('treats garbage as blocked', () => {
  assert.equal(isBlockedIp(''), true)
  assert.equal(isBlockedIp('not-an-ip'), true)
  assert.equal(isBlockedIp('127.0.0'), true)
  assert.equal(isBlockedIp('localhost'), true)
  assert.equal(isBlockedIp('0x7f000001'), true)
  assert.equal(isBlockedIp('2130706433'), true)
})

test('normalizeIp strips brackets and rejects names', () => {
  assert.equal(normalizeIp('[::1]'), '::1')
  assert.equal(normalizeIp(' 1.1.1.1 '), '1.1.1.1')
  assert.equal(normalizeIp('example.com'), null)
  assert.equal(normalizeIp('[1.1.1.1]'), '1.1.1.1')
})

test('ipsEqual treats compressed and expanded IPv6 as the same', () => {
  assert.equal(ipsEqual('::1', '0:0:0:0:0:0:0:1'), true)
  assert.equal(ipsEqual('[::1]', '::1'), true)
  assert.equal(ipsEqual('127.0.0.1', '127.0.0.1'), true)
  assert.equal(ipsEqual('127.0.0.1', '10.0.0.1'), false)
  assert.equal(ipsEqual('::1', '127.0.0.1'), false)
})
