export function getOpenCV() {
  return cv; // 'cv' is the global object created by opencv.js
}
  
export function onOpenCVReady(callback) {
  if (window.cv) {
      window.cv.then(resolvedCv => callback(resolvedCv));
  } else {
    window.onOpenCVReady = () => {
      window.cv.then(resolvedCv => callback(resolvedCv));
    };
  }
}