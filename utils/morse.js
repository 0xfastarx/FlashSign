'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================
//  Custom Morse Cipher - Enkripsi & Dekripsi
//  Mapping terintegrasi langsung di dalam kode (Aman & Rahasia)
// ============================================

// Konfigurasi Kriptografi Keamanan
const SECRET_PASSPHRASE = "fery-morse-secure-passphrase-2026";
const SALT = "fery-salt-12345";

// Derive key 32-byte menggunakan Scrypt
const KEY = crypto.scryptSync(SECRET_PASSPHRASE, SALT, 32);

// Database Morse terenkripsi AES-256-CBC yang disatukan langsung dalam program
const ENCRYPTED_DATABASE = "dd267c34168664879061e1ce7cfd7aaf:436ba6d51e5590f5e58f72e509787afbf08aec6c50a8a05d99f4988788654e76a9055eea47d9bb6cce1253bea0b3dc97935069b820aa8a179a8fb0c779daee932ff3343f1e0dda60233d56025cf40256bdad35dc8b8f3588c80cb5c3a10bc2b60f821b7bb880133661c9bca2a97a73b5d2c29e6a2de8b3818e410ad9903373f879ba9aed24239413858a7be759c724a2e3270ed3059e19d438ed55df9da1a0d3b7c389b10dbea13449ee61f48f613520743178313ca67722847880024958b0356007c51920271f884eb1b9434d5c0e9f160475bbe99823547c796442d9d9acead9674acedb06eb2a4158e14b2a0f322c17edf63baaa676d5b012abe9b0847428524fad380d2217391f3e31333d4e17aab5bdc9cd4923895c229bfd4c835f50cfe6dae6913a6e00474d99e5a7e541c939c8ccc090fd92f6e1b725c7189aab9ce343e99f24f32ae546f13582a31a3c2cdd92d0ec3cc1b008dae447187e77830697cc98be4c073e9f7197c749b971ee18ff9ef26ba43a573b0b39968c689c1e2e87b4f6289566af8658b1f34365a7479f03048fc9d1006fadfa461514b664cdfc8e84b16b6cb35e3f66cb769a5e216c280b638be7b0a98deba3c13a01b0399ce42c2db6f168dc00695945eeaf3e001507902570e2577800376e3c3f1e9d626ee02e7836500beb9e3ddb45ffd68081670dc602b5dbb3ce7410a3fa71484a3cd39f1e5d8d841437834a481d0fa11699ef4215ad6f93f6b98dc6c78f36fc9c2a2e646fa7103afaaa79a2bf01d0c1de819512dbf7d2b3b90572ef15507a86486a32557f1f7af2128e116736eac3968f0802496c6fcc15b9aedb9495b1edd85909c59a857c4c4b4ac8c5b290e66ef5ddf26e6f65bfd3fde658aee5b6685de0bcb4d52edf1f04e5d85cd7f6c33e9e2b27a17ce3938ed2372586c4a45b8a05adcd30d091c0a19ff5ec233f16f82dbc29737719f9ffc0966b89fb92f740458e893931f234e909375a50de19461670b56bacee9f531d6d8054c85d9eca1289d75c1923c3f239bb2c46976db442b30e8b0794be11d43a51ce60f3f79a9591e6744c826eb4e104db3e79fcb3a1516870d6ca68b9c342522fa33543de7454a4e9b753bd8247ea8c41028c747b4e9028d7dd0b3b6f7249d7a5909ef19475e21b98a892d992292b6ec2916832eb6c0eea18a5a1bd5b6dcdb2f56f7b7b78beae76097a31ec3769cf001777c8931dd4499813f0b56f0b2dc2216de92f0a1d7d981c1049c880f2bc7da54c1c056bfa6357ebd436a4991c196e49b3dc1fe3377ef7ecf6d0be23823b259a7a3a91f13fe2a911b401f7982f834a3f630a30b3dab30b46400ad04758134e98012e7c7defe50d1d4bce9a81135cdecaf22cd109a449f2990cbaab393ddbc98e165e210eddab0a88a85311b108c3957798ab4979af9cdce8107cab29fc86e060a16f4d4682ad9ab54cf3a91ab6f2fe3cb69e25a46540cc1cf41f6705d7188e32af5ec97ab393f3084820cbab0de6514c950fb584e8fdf1a006f7573339a5023cc54dd8f6854f66e77301bc90093a174fb395a9de192b661550bc6b2845b244c6dd6165ba29cfa0c9db492679b50046e60593207ab0300d6e7b5c9a51891216c9aaf59ba50b90166f6193c8d4f15a3cdf53c9c07e5f1c1fe67356c459391da20e6f6975fb586d129335e35243f49b143344bf35062ee399eb0eda2855009a8d412a577c6779624028470940623c683c3eb45e572d95dcfa039d1945567383ec743efada28670221360d915ef6bc4c97d1e8ba5837c1c80ebd71b2e5a36e777ef7b4d6d4c5c7c57009a1231da6e0ef6fca0d4dfb93fd20b41200ea7c6219dfc274b9953fe6e971cea5f3a5406fbc4485c058f5687976434275fa7973866e63599d205262d909e349e762d302801d5cfc7a72bbc334ba7834352c8f262460f64bc54bcb74ad7563a9f81ef193619decd04e401dee0a0f83d1e40b7d7e67b158f96654f5de9403cabadc7f58716e78cca501619745620585d670d691a69de435616e3c52ab3b532e3843d4c36d52e55bd610ea64b371cd024ab60775449d9dc3a7fc15a021f376c46e418e5094bfb1381ddadc834e9354060c28ff529a8847f0e8adb0db504014933f83f2fb47a3be371b435d86c4877017a31c2cb1256339c75817e3e12ef960b89daee24abec204ad035db013cc1cb2d85894a683cb32f3cdd97e94f97799acdb2c58a63271d2fb6918492acabcfbd474067a21ed088fb7abf4209d95d662d9e382636d1753b92bf952820330481e80dc0e90d734d1c9c76c8b8f7b05f783ec3906b5bcfcf818b5aea35c341e581ed294a669d4e44f6b44c3bd97db01352f8c0e1e88e0092fc7fbf2038a05561324b0283d4eceed0a799f2686b49c6d7268131951bc954a66788b818b23aa816a2173cf96b8756e415a5b84929a1c1530fdc6a3337682134645981e7721a16f35ab1ce533d648e16ee02376af963bdc14c650dccab3c67561daae64494fe98014ea73b26abe3919cc913b4ad3b91eb0bba8e650e88f19627b77a5db463b166cf8294dce84bcbb2eff0f164a6164";

/**
 * Dekripsi teks mapping menggunakan AES-256-CBC
 */
function decryptData(encryptedText) {
  const parts = encryptedText.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Format data terenkripsi tidak valid");
  }
  const iv = Buffer.from(parts[0], "hex");
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Parse mapping morse dari database terenkripsi yang disatukan di program
 */
function parseMorseFile() {
  let content = "";
  try {
    content = decryptData(ENCRYPTED_DATABASE);
  } catch (e) {
    console.error("\n  ❌ Gagal mendekripsi database internal! Program rusak.");
    process.exit(1);
  }

  const lines = content.split("\n");
  const morseMap = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip baris kosong, header, separator, dan komentar
    if (!trimmed) continue;

    // Hentikan parsing jika sudah masuk bagian CONTOH
    if (trimmed.includes("CONTOH")) {
      break;
    }

    if (trimmed.startsWith("=")) continue;
    if (trimmed.startsWith("-")) continue;

    // Parse format "CHAR = CODE"
    const match = trimmed.match(/^(.+?)\s*=\s*(.+)$/);
    if (match) {
      const char = match[1].trim();
      const code = match[2].trim();

      // Khusus SPACE
      if (char === "SPACE") {
        morseMap[" "] = code;
      } else if (char.length === 1) {
        // Pertahankan case asli (huruf besar & kecil dibedakan)
        morseMap[char] = code;
      }
    }
  }

  return morseMap;
}

/**
 * Buat reverse map (kode -> karakter) untuk dekripsi
 */
function buildReverseMap(morseMap) {
  const reverseMap = {};
  for (const [char, code] of Object.entries(morseMap)) {
    reverseMap[code] = char;
  }
  return reverseMap;
}

/**
 * ENKRIPSI: Mengubah teks biasa menjadi kode morse custom
 */
function encrypt(text, morseMap) {
  const spaceCode = morseMap[" "] || "!!!!!!!!";
  const result = [];

  for (const char of text) {
    if (char === " ") {
      result.push(spaceCode);
    } else if (morseMap[char]) {
      result.push(morseMap[char]);
    } else {
      // Karakter tidak dikenali, lewati
      console.warn(`  ⚠  Karakter '${char}' tidak ditemukan di mapping, dilewati.`);
    }
  }

  return result.join(" ");
}

/**
 * DEKRIPSI: Mengubah kode morse custom kembali ke teks biasa
 */
function decrypt(cipherText, morseMap) {
  const reverseMap = buildReverseMap(morseMap);
  const spaceCode = morseMap[" "] || "!!!!!!!!";
  const codes = cipherText.trim().split(/\s+/);
  let result = "";

  for (const code of codes) {
    if (code === spaceCode) {
      result += " ";
    } else if (reverseMap[code]) {
      result += reverseMap[code];
    } else {
      console.warn(`  ⚠  Kode '${code}' tidak ditemukan di mapping, dilewati.`);
    }
  }

  return result;
}

/**
 * ENKRIPSI FILE: Memproses per baris agar tata letak terjaga sempurna.
 * Karakter yang tidak ada di mapping disimpan sebagai kode escape <<hex>>
 * sehingga saat didekripsi akan 100% identik dengan file asli.
 */
function encryptFile(text, morseMap) {
  const spaceCode = morseMap[" "] || "!!!!!!!!";
  const lines = text.split("\n");

  const encryptedLines = lines.map((line) => {
    if (line === "") return ""; // Baris kosong tetap kosong

    const result = [];
    for (const char of line) {
      if (char === " ") {
        result.push(spaceCode);
      } else if (morseMap[char]) {
        result.push(morseMap[char]);
      } else {
        // Karakter tidak dikenali → simpan sebagai escape <<hex>>
        const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
        result.push(`<<${hex}>>`);
      }
    }
    return result.join(" ");
  });

  return encryptedLines.join("\n");
}

/**
 * DEKRIPSI FILE: Memproses per baris dan mengembalikan karakter escape <<hex>>
 * ke bentuk aslinya. Hasilnya dijamin identik 100% dengan file sebelum dienkripsi.
 */
function decryptFile(cipherText, morseMap) {
  const reverseMap = buildReverseMap(morseMap);
  const spaceCode = morseMap[" "] || "!!!!!!!!";
  const lines = cipherText.split("\n");

  const decryptedLines = lines.map((line) => {
    if (line === "") return ""; // Baris kosong tetap kosong

    const codes = line.split(/\s+/);
    let result = "";

    for (const code of codes) {
      if (!code) continue;
      if (code === spaceCode) {
        result += " ";
      } else if (code.startsWith("<<") && code.endsWith(">>")) {
        // Decode karakter escape
        const hex = code.slice(2, -2);
        result += String.fromCharCode(parseInt(hex, 16));
      } else if (reverseMap[code]) {
        result += reverseMap[code];
      }
    }

    return result;
  });

  return decryptedLines.join("\n");
}

module.exports = {
  parseMorseFile,
  buildReverseMap,
  encrypt,
  decrypt,
  encryptFile,
  decryptFile
};
