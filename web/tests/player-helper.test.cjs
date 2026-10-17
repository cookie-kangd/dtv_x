const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// 直接执行真实的取流辅助函数，只替换桌面 IPC；无需启动 WebView。
function loadHelper(platform, invoke) {
  const file = path.join(__dirname, '../src/platforms', platform, 'playerHelper.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const requireMock = (id) => {
    if (id === '@tauri-apps/api/core') return { invoke };
    if (id === '@tauri-apps/api/event') return { listen: async () => () => {} };
    if (id === 'uuid') return { v4: () => 'test' };
    if (id === '@/utils/logger') {
      return { logger: { debug() {}, error() {}, warn() {} } };
    }
    if (id === '../common/types') return { Platform: { DOUYIN: 'DOUYIN' } };
    throw new Error(`测试未提供依赖：${id}`);
  };
  vm.runInNewContext(
    source,
    {
      exports,
      require: requireMock,
      console: { error() {}, warn() {}, debug() {}, log() {} },
      setTimeout,
      clearTimeout,
      URL,
      localStorage: { getItem: () => null },
    },
    { filename: file }
  );
  return exports;
}

test('B站接口暂时失败会重试，不误判未开播', async () => {
  let calls = 0;
  const helper = loadHelper('bilibili', async () =>
    ++calls === 1
      ? { error_message: '请求超时', status: null }
      : { status: 1, stream_url: 'https://cdn/live.flv' }
  );
  const result = await helper.getBilibiliStreamConfig('1');
  assert.equal(calls, 2);
  assert.equal(result.streamUrl, 'https://cdn/live.flv');
  assert.equal(result.streamType, 'flv');
});

test('B站明确未开播只请求一次', async () => {
  let calls = 0;
  const helper = loadHelper('bilibili', async () => {
    calls += 1;
    return { status: 0, stream_url: null };
  });
  await assert.rejects(() => helper.getBilibiliStreamConfig('1'), /未开播/);
  assert.equal(calls, 1);
});

test('B站候选数量按同画质流返回', async () => {
  const helper = loadHelper('bilibili', async () => ({
    status: 1,
    stream_url: 'https://cdn/live.flv',
    available_streams: [{ url: 'https://cdn/live.flv' }, { url: 'https://cdn/b.m3u8' }],
  }));
  const result = await helper.getBilibiliStreamConfig('1');
  assert.equal(result.candidateCount, 2);
});

test('虎牙房间详情临时失败不当作离线', async () => {
  let calls = 0;
  const helper = loadHelper('huya', async (command) => {
    if (command === 'get_huya_unified_cmd') {
      calls += 1;
      if (calls === 1) throw new Error('获取房间详情超时');
      return {
        is_live: true,
        candidate_urls: ['http://cdn/live.flv'],
        selected_url: 'http://cdn/live.flv',
        flv_tx_urls: [{ quality: '原画', bitRate: 0, url: 'http://cdn/live.flv' }],
      };
    }
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
    return undefined;
  });
  const result = await helper.getHuyaStreamConfig('1');
  assert.equal(calls, 2);
  assert.equal(result.streamUrl, 'http://127.0.0.1:1234/live.flv');
  assert.equal(result.candidateCount, 1);
});

test('虎牙按候选索引换线路且不改写协议', async () => {
  let upstream;
  const helper = loadHelper('huya', async (command, payload) => {
    if (command === 'get_huya_unified_cmd') {
      return {
        is_live: true,
        candidate_urls: ['http://cdn/a.flv', 'http://cdn/b.flv', 'http://cdn/c.flv'],
        flv_tx_urls: [],
      };
    }
    if (command === 'set_stream_url_cmd') upstream = payload.url;
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
    return undefined;
  });
  const result = await helper.getHuyaStreamConfig('1', '原画', null, 1);
  assert.equal(upstream, 'http://cdn/b.flv');
  assert.equal(result.candidateCount, 3);
});

test('斗鱼保留服务端 HTTP 协议并透传候选索引', async () => {
  let upstream;
  let args;
  const helper = loadHelper('douyu', async (command, payload) => {
    if (command === 'get_stream_url_with_quality_cmd') {
      args = payload;
      return 'http://cdn/live.flv';
    }
    if (command === 'set_stream_url_cmd') upstream = payload.url;
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
    return undefined;
  });
  await helper.getDouyuStreamConfig('1', '原画', 'ws-h5', 2);
  assert.equal(args.candidateIndex, 2);
  assert.equal(upstream, 'http://cdn/live.flv');
});
