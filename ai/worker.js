// 推論用の Web Worker。{ id, feat, mask } を受け取り、{ id, probs } を返す。重みは最初の 1 回だけ読む。
import { loadNet } from './net.js';

let net = null;
self.onmessage = async ({ data: { id, feat, mask } }) => {
  try {
    net = net || await loadNet(new URL('./model.bin', import.meta.url));
    self.postMessage({ id, probs: net.forward(feat, mask).probs.slice() });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
