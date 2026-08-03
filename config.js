// config.js — public client configuration.
//
// The OAuth CLIENT_ID is NOT a secret: it is designed to ship in the browser.
// The `drive.file` scope means the app can only ever touch files and folders it
// creates itself — it cannot see anything else in your Drive. Paste your Client
// ID here after the Google Cloud setup (see chat for the steps).
window.CONFIG = {
  CLIENT_ID: "825047123967-n07i9qn9rnh669n03q552msdkvlc7n7r.apps.googleusercontent.com",
  SCOPE: "https://www.googleapis.com/auth/drive.file",
  ROOT_FOLDER: "food_log",
};
