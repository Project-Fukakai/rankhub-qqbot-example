/**
 * RankHub 用户二维码：内容与 App「我的二维码」一致
 * `rankhub://user/<uid>?ref=qrcode`（见 App lib/models/rankhub/user_link.dart）。
 *
 * 只生成图片，不做任何网络请求；隐私判断在调用方（`profile.isPublic`）。
 */
import QRCode from 'qrcode';

export interface UserQrOptions {
  /** 边距（模块数），App 用 1。 */
  margin?: number;
  /** 输出边长（像素）。 */
  width?: number;
}

/** 生成 RankHub 用户二维码 PNG；uid 非法时返回 null。 */
export async function renderUserQr(uid: string, options: UserQrOptions = {}): Promise<Buffer | null> {
  const normalized = uid.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const data = `rankhub://user/${normalized}?ref=qrcode`;
  return QRCode.toBuffer(data, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: options.margin ?? 1,
    width: options.width ?? 640,
    color: { dark: '#111111ff', light: '#ffffffff' },
  });
}
