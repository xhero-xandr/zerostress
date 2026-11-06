// One request to the cloud metadata address. No data is read from the answer and none is sent anywhere.
fetch('http://169.254.169.254/latest/meta-data/', { mode: 'no-cors' })
  .then(function () { document.getElementById('out').textContent = 'The request was sent.'; })
  .catch(function () { document.getElementById('out').textContent = 'The request was blocked.'; });
