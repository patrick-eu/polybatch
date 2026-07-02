// 复制按钮：扩展页默认 CSP 禁内联脚本，故用外部文件
document.querySelectorAll('.copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(btn.dataset.addr); } catch (e) { return; }
    btn.textContent = 'Copied!'; btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy address'; btn.classList.remove('done'); }, 1400);
  });
});
