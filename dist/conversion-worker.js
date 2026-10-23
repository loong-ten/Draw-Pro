import { convertPixels } from './conversion-core.js';

self.onmessage = ({ data: message }) => {
  const id = message?.id;
  try {
    const result = convertPixels(message.image, message.options);
    self.postMessage({ id, result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || '像素转换未完成，请调整参数后重试。' });
  }
};
