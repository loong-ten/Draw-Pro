import { analyzeGrid, processPixels } from './pixel-core.js';

let source = null;
let version = 0;
self.onmessage = ({ data: message }) => {
  try {
    if (message.type === 'load') {
      source = message.image;
      version = message.version;
      return;
    }
    if (!source || message.version !== version) return;
    if (message.type === 'analyze') {
      self.postMessage({ type: 'analysis', version, id: message.id, analysis: analyzeGrid(source) });
    } else if (message.type === 'process') {
      const start = performance.now();
      const result = processPixels(source, message.options);
      self.postMessage({ type: 'result', version, id: message.id, result, elapsed: performance.now() - start }, [result.data.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', version, id: message.id, task: message.type, message: error.message || '处理未完成' });
  }
};
