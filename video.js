// A LumenPnP fiducial is documented as 1mm in diameter (help.html) - used
// below to size the HoughCircles search band off the live pxPerMm value.
const FIDUCIAL_DIAMETER_MM = 1;

export class VideoManager {
  constructor(cv) {
    this.cv = cv;
    this.video = null;

    // How many camera pixels correspond to 1mm on the board, at this
    // camera's working distance/zoom. Everything that has to translate
    // between on-screen pixels and real board mm - lumen.js's
    // jogToFiducial() (converts a detected circle's pixel offset into a jog
    // distance) and CVdetectCircle() below (sizes its fiducial search band) -
    // reads this live off the VideoManager instance rather than a hardcoded
    // constant, so retuning it (see the Camera Scale input next to the video
    // feed) takes effect immediately, with no reload, on a different camera/
    // lens/working height. 50px/mm is this app's original hardcoded
    // assumption, kept as the default.
    this.pxPerMm = 50;

    // canvas object that we write to
    this.canvas = null;

    // this is the raw frame from the cam, oriented correctly
    this.frame = null;

    // this is the frame that's been processed through CV
    this.cvFrame = null;

    // flag that determines if we should display the cv image
    this.displayCv = false;

    // timer that keeps track of how long we show the cv image
    this.cvDisplayTimer = null;

    // guards the videoTick() requestAnimationFrame loop - without this, a
    // camera switch (stopVideo then startVideo) leaves the old loop with no
    // way to know it should stop, and it throws against a now-null
    // this.video on its next tick instead of exiting cleanly.
    this.running = false;
  }

  async populateCameraList(selectElement) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');

      // Preserve whatever's currently selected across a refresh - this gets
      // called again once camera permission is granted (so labels are
      // actually populated instead of blank), and that shouldn't silently
      // reset a camera the user already picked/has running.
      const previousValue = selectElement.value;

      selectElement.innerHTML = '';

      videoDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Camera ${index + 1}`;
        selectElement.appendChild(option);
      });

      if (previousValue && videoDevices.some(device => device.deviceId === previousValue)) {
        selectElement.value = previousValue;
      } else {
        // if likely top cam, select it
        const topCam = videoDevices.find(device => device.label && device.label.toLowerCase().includes('top'));
        if (topCam) selectElement.value = topCam.deviceId;
      }
    } catch (err) {
      console.error('Error populating camera list:', err);
    }
  }

  async startVideo(cameraId, canvas) {
    
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: cameraId ? { exact: cameraId } : undefined
        }
      });

      this.video = document.createElement('video');
      this.video.srcObject = stream;
      this.video.setAttribute('playsinline', true);
      this.canvas = canvas;

      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          // set canvas dimensions to match video
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
          resolve();
        };
      });

      await this.video.play();

      this.frame = new this.cv.Mat(this.video.videoHeight, this.video.videoWidth, this.cv.CV_8UC4);

      this.running = true;
      this.videoTick();
    
  }

  addReticle(frame){
    const centerX = frame.cols / 2;
    const centerY = frame.rows / 2;
    const reticleSize = 20;  
    const reticleColor = new this.cv.Scalar(255, 200, 0, 255); 
    const reticleThickness = 3;  
    
    let frameWithReticle = frame.clone();
    
    // horizontal line
    this.cv.line(
        frameWithReticle,
        new this.cv.Point(centerX - reticleSize, centerY),
        new this.cv.Point(centerX + reticleSize, centerY),
        reticleColor,
        reticleThickness
    );

    // vertical line
    this.cv.line(
        frameWithReticle,
        new this.cv.Point(centerX, centerY - reticleSize),
        new this.cv.Point(centerX, centerY + reticleSize),
        reticleColor,
        reticleThickness
    );

    return frameWithReticle;
  }

  showFrame(frame){

    // Display the processed frame
    this.cv.imshow(this.canvas, frame);

  }

  // ALL FUNCTIONS that start with CV create a new frame in this.cvFrame that can be displayed
  // with this.displayCvFrame (which should only be called by lumen)
  // and they all return data that's useful for decision making

  // returns the position of the highest-scoring circle, or null if no circles found
  //also adds result of cv to this.cvFrame
  CVdetectCircle() {
    try {
        // clone frame to this.cvFrame
        this.cvFrame = this.frame.clone();

        let gray = new this.cv.Mat();
        this.cv.cvtColor(this.cvFrame, gray, this.cv.COLOR_RGBA2GRAY);
        this.cv.GaussianBlur(gray, gray, new this.cv.Size(9, 9), 2, 2);
        let circles = new this.cv.Mat();

        // A real fiducial should read as FIDUCIAL_DIAMETER_MM's worth of
        // radius in pixels at this camera's current pxPerMm. HoughCircles'
        // minRadius/maxRadius used to be a nearly unbounded 1-50px, which let
        // in any circular-ish blob from a stray pixel up to a huge smudge -
        // silkscreen text loops, round pads/vias, logos, etc. Searching a
        // band around the expected radius instead (with generous +/-40%
        // margin for focus/height variance) rejects most of those before
        // they can ever be considered. Computed fresh every call (not cached)
        // since pxPerMm can be retuned live from the Camera Scale input.
        const expectedRadiusPx = (FIDUCIAL_DIAMETER_MM / 2) * this.pxPerMm;
        const minRadius = Math.max(1, Math.round(expectedRadiusPx * 0.6));
        const maxRadius = Math.max(minRadius + 1, Math.round(expectedRadiusPx * 1.4));

        this.cv.HoughCircles(
            gray,
            circles,
            this.cv.HOUGH_GRADIENT,
            1,
            gray.rows / 8,
            50,
            // Accumulator threshold - how strong a circle's edge evidence has
            // to be to count as a detection. Raised from 30 to require more
            // confident evidence, on top of the tighter radius band below,
            // for further rejecting weak/partial circular shapes (silkscreen
            // text, etc.) that would otherwise still sneak through.
            40,
            minRadius,
            maxRadius
        );

        let bestCircle = null;
        if (circles.cols > 0) {
            // get best one
            console.log(circles.cols);
            for(let i = 0; i < circles.cols; i++){
              const x = circles.data32F[i*3+0];
              const y = circles.data32F[i*3+1];
              const radius = circles.data32F[i*3+2];
              if (bestCircle === null){
                bestCircle = [x, y, radius];
              }else{
                // Choose circle closest to center
                let center_x = this.cvFrame.cols/2;
                let center_y = this.cvFrame.rows/2;
                let dx = x-center_x;
                let dy = y-center_y;
                let dist = Math.sqrt(dx*dx+dy*dy);

                let old_dx = bestCircle[0]-center_x;
                let old_dy = bestCircle[1]-center_y;
                let old_dist = Math.sqrt(old_dx*old_dx+old_dy*old_dy);

                if(dist < old_dist){
                  bestCircle = [x, y, radius];
                }
              }
              console.log("Circle %d, %d, rad %d", x, y, radius);
              console.log(this.cvFrame.cols, this.cvFrame.rows);
              // draw that bad boi
              this.cv.circle(this.cvFrame, new this.cv.Point(x, y), 3, new this.cv.Scalar(0, 255, 0, 255), -1);
              this.cv.circle(this.cvFrame, new this.cv.Point(x, y), radius, new this.cv.Scalar(255, 0, 0, 255), 3);
            }
        }
        console.log("Best circle: ", bestCircle);
        gray.delete();
        circles.delete();

        this.addReticle(this.cvFrame);

        return bestCircle;

    } catch (error) {
        console.error('Error in detectCircle:', error);
        return null;
    }
  }

  // this just pulls in a new frame from the video element, puts it into the canvas, flips it,
  // and loads it into this.frame
  loadNewFrame(){
    // Get the current frame for processing
    const context = this.canvas.getContext('2d');
    context.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
    const imageData = context.getImageData(0, 0, this.video.videoWidth, this.video.videoHeight);
    const tempMat = this.cv.matFromImageData(imageData);
    tempMat.copyTo(this.frame);
    tempMat.delete();
    this.cv.flip(this.frame, this.frame, -1);
  }


  // this is what runs like 60hz, and determines if we're showing processed or just streaming
  // then it kicks off whichever we're doing!  
  videoTick() {

    if (!this.running) return;

    if (this.displayCv) {

        this.showFrame(this.cvFrame);

    }

    else{

        this.loadNewFrame();

        this.frame = this.addReticle(this.frame);

        this.showFrame(this.frame);
    }

    // set next frame to fire
    requestAnimationFrame(() => this.videoTick());

  }


  displayCvFrame(time) {
  
    this.displayCv = true;
    
    // set timer to return to normal view after n seconds
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    
    this.processTimer = setTimeout(() => {
      this.displayCv = false;
      this.needsCv = false;
      if (this.cvFrame) {
        this.cvFrame.delete();
        this.cvFrame = null;
      }
      this.processTimer = null;
    }, time);

  }

  stopVideo(canvas) {
    this.isProcessing = false;
    this.running = false;

    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }

    if (this.processedFrame) {
      this.processedFrame.delete();
      this.processedFrame = null;
    }

    if (this.frame) {
      this.frame.delete();
      this.frame = null;
    }

    if (this.cvFrame) {
      this.cvFrame.delete();
      this.cvFrame = null;
    }

    if (this.video && this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(track => track.stop());
      this.video.remove();
      this.video = null;
    }

    if (this.src) {
      this.src.delete();
      this.src = null;
    }

    if (this.dst) {
      this.dst.delete();
      this.dst = null;
    }
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    console.log('Video stopped and cleaned up');
  }

 
}