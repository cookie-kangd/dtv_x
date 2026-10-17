export type LiveRoomTarget = {
  platform: 'bilibili' | 'huya' | 'douyu' | 'douyin';
  roomId: string;
};

// 虎牙/斗鱼把非直播间路径也放在一级目录下，这些是被占用的保留字。
const HUYA_RESERVED = [
  'search', 'index', 'g', 'all', 'video', 'match', 'live', 'l', 'hot',
  'home', 'category', 'zhubo', 'topic',
];
const DOUYU_RESERVED = ['search', 'topic', 'directory', 'category'];

const isNumeric = (value: string | undefined): value is string => !!value && /^\d+$/.test(value);
const isSlug = (value: string | undefined): value is string => !!value && /^[a-zA-Z0-9_-]+$/.test(value);

/**
 * 从粘贴的直播间链接里解析出平台和房间号。
 *
 * 只接受 http/https 且必须匹配已知的直播间路径形态，识别不了时返回 null，
 * 让调用方回退到普通搜索。
 */
export function parseLiveRoomUrl(input: string): LiveRoomTarget | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const [first, second, third] = parts;

  if (url.hostname === 'live.bilibili.com' && parts.length === 1 && isNumeric(first)) {
    return { platform: 'bilibili', roomId: first };
  }

  if (
    url.hostname === 'www.huya.com' &&
    parts.length === 1 &&
    isSlug(first) &&
    !HUYA_RESERVED.includes(first)
  ) {
    return { platform: 'huya', roomId: first };
  }

  if (url.hostname === 'www.douyu.com') {
    if (parts.length === 2 && first === 'topic') {
      const roomId = url.searchParams.get('rid');
      return isNumeric(roomId ?? undefined) ? { platform: 'douyu', roomId: roomId as string } : null;
    }
    if (
      parts.length === 1 &&
      isSlug(first) &&
      !first.startsWith('g_') &&
      !DOUYU_RESERVED.includes(first)
    ) {
      return { platform: 'douyu', roomId: first };
    }
  }

  if (url.hostname === 'live.douyin.com' && parts.length === 1 && isNumeric(first)) {
    return { platform: 'douyin', roomId: first };
  }
  if (
    url.hostname === 'www.douyin.com' &&
    parts.length === 3 &&
    first === 'root' &&
    second === 'live' &&
    isNumeric(third)
  ) {
    return { platform: 'douyin', roomId: third };
  }

  return null;
}
