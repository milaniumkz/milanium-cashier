document.querySelectorAll('[data-copy]').forEach(button=>{
 button.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);button.textContent='Скопировано';setTimeout(()=>button.textContent='Копировать',2000);}catch{button.textContent='Выделите и скопируйте код';}};
});
