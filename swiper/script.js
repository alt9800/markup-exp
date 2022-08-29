const element = document.getElementById("image-compare");

const options = {

  // UI Theme Defaults

  controlColor: "#66cdaa",
  controlShadow: true,
  addCircle: false,
  addCircleBlur: true,

  // Label Defaults

  showLabels: true,
  labelOptions: {
    before: 'warm',
    after: 'cool',
    onHover: false
  },

  // Smoothing

  smoothing: true,
  smoothingAmount: 100,

  // Other options

  hoverStart: false,
  verticalMode: false,
  startingPoint: 50,
  fluidMode: false
};

// Add your options object as the second argument
const viewer = new ImageCompare(element, options).mount();

