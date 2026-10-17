const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadParser() {
  const file = path.join(__dirname, '../src/services/liveRoomUrl.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require, URL }, { filename: file });
  return exports.parseLiveRoomUrl;
}

const parseInVm = loadParser();
// vm 里创建的对象来自另一个 realm，原型不同会让 deepStrictEqual 误报，先归一化。
const parseLiveRoomUrl = (input) => {
  const result = parseInVm(input);
  return result ? { ...result } : result;
};

test('识别四个平台的直播间链接', () => {
  assert.deepEqual(parseLiveRoomUrl('https://live.bilibili.com/22637261'), {
    platform: 'bilibili',
    roomId: '22637261',
  });
  assert.deepEqual(parseLiveRoomUrl('https://www.huya.com/660000'), {
    platform: 'huya',
    roomId: '660000',
  });
  assert.deepEqual(parseLiveRoomUrl('https://www.douyu.com/9999'), {
    platform: 'douyu',
    roomId: '9999',
  });
  assert.deepEqual(parseLiveRoomUrl('https://live.douyin.com/123456'), {
    platform: 'douyin',
    roomId: '123456',
  });
});

test('支持抖音分享链接和斗鱼话题链接', () => {
  assert.deepEqual(parseLiveRoomUrl('https://www.douyin.com/root/live/987654'), {
    platform: 'douyin',
    roomId: '987654',
  });
  assert.deepEqual(parseLiveRoomUrl('https://www.douyu.com/topic/xyz?rid=8888'), {
    platform: 'douyu',
    roomId: '8888',
  });
});

test('忽略查询串并拒绝非直播间页面', () => {
  assert.deepEqual(parseLiveRoomUrl('https://live.bilibili.com/123?broadcast_type=0'), {
    platform: 'bilibili',
    roomId: '123',
  });
  assert.equal(parseLiveRoomUrl('https://www.huya.com/search'), null);
  assert.equal(parseLiveRoomUrl('https://www.douyu.com/directory'), null);
  assert.equal(parseLiveRoomUrl('https://www.douyu.com/g_LOL'), null);
  assert.equal(parseLiveRoomUrl('https://live.bilibili.com/p/eden/rank'), null);
  assert.equal(parseLiveRoomUrl('不是链接'), null);
  assert.equal(parseLiveRoomUrl('ftp://live.bilibili.com/1'), null);
});
