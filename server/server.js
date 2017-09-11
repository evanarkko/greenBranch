'use strict';

// Modules imports
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Load config file
//const config = require('./config.json');

//Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

//LINKEDIN OAUTH SETUP
const credentials = {
   client: {
     id: '7846gh9zqfb0ye', // Change this!
     secret: 'noMpfY3IgzcxM56s', // Change this!
  },
   auth: {
    tokenHost: 'https://api.linkedin.com',
    authorizePath: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenPath: 'https://www.linkedin.com/oauth/v2/accessToken'
   }
};
const oauth2 = require('simple-oauth2').create(credentials);

// Path to the OAuth handlers.
const OAUTH_REDIRECT_PATH = '/redirect';
const OAUTH_CALLBACK_PATH = '/linkedin-callback';
const OAUTH_MOBILE_CALLBACK_PATH = '/linkedin-mobile-callback';
const OAUTH_CODE_EXCHANGE_PATH = '/linkedin-mobile-exchange-code';

// Custom URI scheme for Android and iOS apps.
const APP_CUSTOM_SCHEME = 'linkedin-sign-in-demo';

// Instagram scopes requested.
const OAUTH_SCOPES = 'basic';

// ExpressJS setup
const app = express();
app.enable('trust proxy');
app.use(express.static('public'));
//app.use(express.static('node_modules/instafeed.js'));
app.use(cookieParser());

/**
 * Redirects the User to the Instagram authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */

app.get(OAUTH_REDIRECT_PATH, (req, res) => {
  // Generate a random state verification cookie.
  const state = req.cookies.state || crypto.randomBytes(20).toString('hex');
  // Allow unsecure cookies on localhost.
  const secureCookie = req.get('host').indexOf('localhost:') !== 0;
  res.cookie('state', state.toString(), {maxAge: 3600000, secure: secureCookie, httpOnly: true});
  const redirectUri = oauth2.authorizationCode.authorizeURL({
    //redirect_uri: `${req.protocol}://${req.get('host')}/linkedin-callback`,
    redirect_uri: 'http://localhost:8080/linkedin-callback',
    scope: 'basic',
    state: state
  });
  res.redirect(redirectUri);
});

/**
 * Exchanges a given Instagram auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie to avoid
 * Session Fixation attacks.
 * This is meant to be used by Web Clients.
 */
app.get(OAUTH_CALLBACK_PATH, (req, res) => {
  console.log('Received state cookie:', req.cookies.state);
  console.log('Received state query parameter:', req.query.state);
  if (!req.cookies.state) {
    res.status(400).send('State cookie not set or expired. Maybe you took too long to authorize. Please try again.');
  } else if (req.cookies.state !== req.query.state) {
    res.status(400).send('State validation failed');
  }
  console.log('Received auth code: ', req.query.code);
  oauth2.authorizationCode.getToken({
    code: req.query.code,
    //redirect_uri: `${req.protocol}://${req.get('host')}${OAUTH_CALLBACK_PATH}`
    redirect_uri: 'http://localhost:8080/linkedin-callback'
  }).then(results => {
    console.log('Auth code exchange result received:', results);
    // We have an Instagram access token and the user identity now.
    const accessToken = results.access_token;
    const linkedinUserID = results.user.id;
    const profilePic = results.user.profile_picture;
    const userName = results.user.full_name;

    // Create a Firebase account and get the Custom Auth Token.
    createFirebaseAccount(linkedinUserID, userName, profilePic, accessToken).then(firebaseToken => {
      // Serve an HTML page that signs the user in and updates the user profile.
      res.send(signInFirebaseTemplate(firebaseToken, userName, profilePic, accessToken));
    });
  });
});

/**
 * Passes the auth code to your Mobile application by redirecting to a custom scheme URL. This serves as a fallback in
 * case App Link/Universal Links are not supported on the device.
 * Native Mobile apps should use this callback.
 */
app.get(OAUTH_MOBILE_CALLBACK_PATH, (req, res) => {
  res.redirect(`${APP_CUSTOM_SCHEME}:/${OAUTH_MOBILE_CALLBACK_PATH}?${req.originalUrl.split('?')[1]}`);
});

/**
 * Exchanges a given Instagram auth code passed in the 'code' URL query parameter for a Firebase auth token and returns
 * a Firebase Custom Auth token, Instagram access token and user identity as a JSON object.
 * This endpoint is meant to be used by native mobile clients only since no Session Fixation attacks checks are done.
 */
app.get(OAUTH_CODE_EXCHANGE_PATH, (req, res) => {
  console.log('Received auth code:', req.query.code);
  oauth2.authCode.getToken({
    code: req.query.code,
    redirect_uri: `${req.protocol}://${req.get('host')}${OAUTH_MOBILE_CALLBACK_PATH}`
  }).then(results => {
    console.log('Auth code exchange result received:', results);

    // Create a Firebase Account and get the custom Auth Token.
    createFirebaseAccount(results.user.id, results.user.full_name,
        results.user.profile_picture, firebaseToken).then(firebaseToken => {
      // Send the custom token, access token and profile data as a JSON object.
      res.send(firebaseToken);
    });
  });
});


/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /instagramAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
function createFirebaseAccount(linkedinID, displayName, photoURL, accessToken) {
  // The UID we'll assign to the user.
  const uid = `linkedin:${linkedinID}`;

  /*// Save the access token to the Firebase Realtime Database.
  const databaseTask = admin.database().ref(`/instagramAccessToken/${uid}`)
      .set(accessToken); TODO: FIGURE THIS OUT*/

  // Create or update the user account.
  const userCreationTask = admin.auth().updateUser(uid, {
    displayName: displayName,
    photoURL: photoURL
  }).catch(error => {
    // If user does not exists we create it.
    if (error.code === 'auth/user-not-found') {
      return admin.auth().createUser({
        uid: uid,
        displayName: displayName,
        photoURL: photoURL
      });
    }
    throw error;
  });

  // Wait for all async task to complete then generate and return a custom auth token.
  return Promise.all([userCreationTask, databaseTask]).then(() => {
    // Create a Firebase custom auth token.
    const token = admin.auth().createCustomToken(uid);
    console.log('Created Custom token for UID "', uid, '" Token:', token);
    return token;
  });
}

/**
 * Generates the HTML template that signs the user in Firebase using the given token and closes the
 * popup.
 */
function signInFirebaseTemplate(token) {
  return `
    <script src="https://www.gstatic.com/firebasejs/3.6.0/firebase.js"></script>
    <script>
      var token = '${token}';
      var config = {
        apiKey: '${config.firebase.apiKey}'
      };
      var app = firebase.initializeApp(config);
      app.auth().signInWithCustomToken(token).then(function() {
        window.close();
      });
    </script>`;
}

// Start the server
var server = app.listen(process.env.PORT || '8080', function () {
  console.log('App listening on port %s', server.address().port);
  console.log('Press Ctrl+C to quit.');
});
