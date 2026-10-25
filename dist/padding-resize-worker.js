import { resampleRGBA } from './image-resampling.js';

self.onmessage = ({ data: message }) => {
  const id = message?.id;
  try {
    const result = resampleRGBA(message.image, message.options);
    self.postMessage({ id, result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: { name: error?.name || 'Error', message: error?.message || '图像缩放未完成。' } });
  }
};
