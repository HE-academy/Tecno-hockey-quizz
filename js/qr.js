// Lectura del QR del proyector desde la app: cámara en directo o, si no hay
// permiso/cámara, una foto. BarcodeDetector nativo cuando existe (Android);
// si no (iPhone), jsQR por CDN.

export const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

// Acepta la URL del QR (…?c=ABC234) o el código suelto.
export function extraerCodigo(texto) {
  if (!texto) return null;
  const limpio = texto.trim();
  try {
    const c = new URL(limpio).searchParams.get('c');
    if (c && /^[A-Z2-9]{6}$/i.test(c)) return c.toUpperCase();
  } catch { /* no es URL */ }
  return /^[A-Z2-9]{6}$/i.test(limpio) ? limpio.toUpperCase() : null;
}

let jsqrPromesa = null;
function cargarJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrPromesa ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSQR;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsqrPromesa = null; reject(new Error('jsQR no disponible')); };
    document.head.append(s);
  });
  return jsqrPromesa;
}

async function crearDecodificador() {
  if ('BarcodeDetector' in window) {
    try {
      const formatos = await window.BarcodeDetector.getSupportedFormats();
      if (formatos.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (fuente) => (await det.detect(fuente))[0]?.rawValue ?? null;
      }
    } catch { /* cae a jsQR */ }
  }
  const jsQR = await cargarJsQR();
  const lienzo = document.createElement('canvas');
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  return async (fuente) => {
    const w = fuente.videoWidth || fuente.width;
    const h = fuente.videoHeight || fuente.height;
    if (!w || !h) return null;
    const escala = Math.min(1, 960 / Math.max(w, h));
    lienzo.width = Math.round(w * escala);
    lienzo.height = Math.round(h * escala);
    ctx.drawImage(fuente, 0, 0, lienzo.width, lienzo.height);
    const img = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

async function decodificarFoto(archivo, decodificar) {
  const bmp = await createImageBitmap(archivo);
  try {
    return await decodificar(bmp);
  } finally {
    bmp.close?.();
  }
}

// Abre el escáner a pantalla completa. Devuelve el código o null si se cancela.
export function escanearQR() {
  return new Promise((resolve) => {
    const capa = document.createElement('div');
    capa.className = 'escaner';
    capa.innerHTML = `
      <video playsinline muted></video>
      <div class="marco"></div>
      <div class="pie">
        <p class="msg">Apunta al QR del proyector</p>
        <label class="btn secundario bloque" style="margin:0">
          Hacer una foto al QR
          <input type="file" accept="image/*" capture="environment" hidden>
        </label>
        <button class="btn oscuro bloque" type="button" data-cancelar>Cancelar</button>
      </div>`;
    document.body.append(capa);
    const video = capa.querySelector('video');
    const msg = capa.querySelector('.msg');
    let flujo = null;
    let activo = true;
    let decodificar = null;

    const terminar = (codigo) => {
      activo = false;
      flujo?.getTracks().forEach((t) => t.stop());
      capa.remove();
      resolve(codigo);
    };

    const probar = (texto) => {
      const codigo = extraerCodigo(texto);
      if (codigo) { navigator.vibrate?.(40); terminar(codigo); return true; }
      if (texto) msg.textContent = 'Ese QR no es de un cuestionario. Prueba otra vez.';
      return false;
    };

    capa.querySelector('[data-cancelar]').onclick = () => terminar(null);
    capa.querySelector('input[type=file]').onchange = async (e) => {
      const archivo = e.target.files?.[0];
      if (!archivo) return;
      msg.textContent = 'Leyendo la foto…';
      try {
        decodificar ??= await crearDecodificador();
        if (!probar(await decodificarFoto(archivo, decodificar))) {
          msg.textContent = 'No encuentro el QR en la foto. Acércate un poco y que salga entero.';
        }
      } catch {
        msg.textContent = 'No he podido leer la foto. Escribe el código a mano.';
      }
    };

    (async () => {
      try {
        decodificar = await crearDecodificador();
      } catch {
        msg.textContent = 'Sin conexión para cargar el lector. Escribe el código a mano.';
        return;
      }
      try {
        flujo = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        msg.textContent = 'Sin permiso de cámara. Usa "Hacer una foto al QR".';
        return;
      }
      if (!activo) { flujo.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = flujo;
      await video.play().catch(() => {});
      const bucle = async () => {
        if (!activo) return;
        try {
          if (video.readyState >= 2 && probar(await decodificar(video))) return;
        } catch { /* fotograma ilegible: seguir */ }
        setTimeout(bucle, 180);
      };
      bucle();
    })();
  });
}
