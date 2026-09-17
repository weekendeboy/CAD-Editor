window.onerror = function(msg, url, lineNo, columnNo, error) {
  var d = document.createElement('div');
  d.style.position = 'fixed';
  d.style.top = '0';
  d.style.left = '0';
  d.style.zIndex = '9999';
  d.style.background = 'red';
  d.style.color = 'white';
  d.style.padding = '20px';
  d.style.fontSize = '16px';
  d.innerText = 'ERROR: ' + msg + '\\n' + url + ':' + lineNo + ':' + columnNo + '\\n' + (error && error.stack);
  document.body.appendChild(d);
  return false;
};
window.addEventListener("unhandledrejection", function(event) {
  var d = document.createElement('div');
  d.style.position = 'fixed';
  d.style.top = '50px';
  d.style.left = '0';
  d.style.zIndex = '9999';
  d.style.background = 'orange';
  d.style.color = 'white';
  d.style.padding = '20px';
  d.style.fontSize = '16px';
  d.innerText = 'PROMISE REJECTION: ' + event.reason;
  document.body.appendChild(d);
});
