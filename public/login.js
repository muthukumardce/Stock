const form = document.getElementById('login-form');
const error = document.getElementById('login-error');
if (new URLSearchParams(location.search).has('error')) error.textContent = 'Your dashboard session expired. Please sign in again.';
if (new URLSearchParams(location.search).has('updated')) {
  const message = document.getElementById('login-message');
  message.textContent = 'Administrator settings saved. Sign in with your current credentials.';
  message.hidden = false;
}
history.replaceState(null, '', '/login');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true; error.textContent = '';
  try {
    const result = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value})});
    const data = await result.json();
    if (!result.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Please check the fields and try again.');
    location.assign('/');
  } catch (err) { error.textContent = err.message || 'Could not connect to the server.'; }
  finally { button.disabled = false; }
});
