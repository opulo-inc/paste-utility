export function getOpenCV() {
    return cv; // 'cv' is the global object created by opencv.js
  }
  
  // Wait for OpenCV.js to be ready
  export function onOpenCVReady(callback) {
    if (window.cv) {
        window.cv.then(resolvedCv => callback(resolvedCv));
    } else {
      // OpenCV.js calls this function when ready
      window.onOpenCVReady = () => {
        window.cv.then(resolvedCv => callback(resolvedCv));
      };
    }
  }