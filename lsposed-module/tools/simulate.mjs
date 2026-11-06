import fs from 'node:fs'

const BASE = 'http://127.0.0.1:18765'
const [sessionId = 'wxid_test_friend', content = '在干嘛呢'] = process.argv.slice(2)

const payload = {
  type: 'message.in',
  msgId: `sim_${Date.now()}`,
  sessionId,
  chatType: sessionId.endsWith('@chatroom') ? 'group' : 'private',
  sender: { id: sessionId, name: '测试好友', remark: '测试好友' },
  content,
  msgType: 'text',
  timestamp: Math.floor(Date.now() / 1000),
  isGroup: sessionId.endsWith('@chatroom'),
  groupInfo: sessionId.endsWith('@chatroom')
    ? { groupId: sessionId, groupName: '测试群', atMe: true }
    : null,
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null)
console.log('health:', health)
if (!health) process.exit(1)

const started = Date.now()
const res = await fetch(`${BASE}/api/message`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
}).then((r) => r.json())

console.log('elapsed ms:', Date.now() - started)
console.log(JSON.stringify(res, null, 2))
if (res?.reply?.segments?.length) {
  console.log('\n会按这个节奏发出去：')
  res.reply.segments.forEach((seg, i) => {
    const at = i === 0 ? res.reply.delayMs : res.reply.delayMs + i * res.reply.segmentDelayMs
    console.log(`  +${at}ms  ${seg}`)
  })
}
