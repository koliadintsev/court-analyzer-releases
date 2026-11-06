//! macOS: шифрування API-ключів. Випадковий 256-бітний ключ зберігається у в'язці ключів
//! користувача (Keychain), а самі API-ключі шифруються AES-256-GCM. Як і DPAPI у Windows,
//! розшифрувати їх може лише той самий користувач на тому самому Mac.

use std::sync::Mutex;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use security_framework::passwords::{get_generic_password, set_generic_password};

const SERVICE: &str = "com.lexcovery.courtanalyzer";
const ACCOUNT: &str = "api-keys-encryption";
/// errSecItemNotFound
const ITEM_NOT_FOUND: i32 = -25300;
const KEY_LEN: usize = 32;
const DECRYPT_FAILED: &str = "не вдалося розшифрувати (ключ збережено іншим користувачем macOS або на іншому комп'ютері)";

/// Ключ кешується, щоб звертатися до в'язки ключів один раз за запуск. М'ютекс також
/// не дає двом одночасним викликам створити два різні ключі.
static MASTER: Mutex<Option<[u8; KEY_LEN]>> = Mutex::new(None);

fn master_key() -> Result<[u8; KEY_LEN], String> {
    let mut cached = MASTER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(key) = *cached {
        return Ok(key);
    }
    let key = match get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => <[u8; KEY_LEN]>::try_from(bytes.as_slice()).map_err(|_| "ключ шифрування у в'язці ключів macOS пошкоджено".to_string())?,
        Err(e) if e.code() == ITEM_NOT_FOUND => {
            let mut key = [0u8; KEY_LEN];
            SystemRandom::new().fill(&mut key).map_err(|_| "не вдалося згенерувати ключ шифрування".to_string())?;
            set_generic_password(SERVICE, ACCOUNT, &key).map_err(|e| format!("не вдалося зберегти ключ шифрування у в'язці ключів macOS: {e}"))?;
            key
        }
        Err(e) => return Err(format!("немає доступу до в'язки ключів macOS: {e}")),
    };
    *cached = Some(key);
    Ok(key)
}

pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    seal(&master_key()?, data)
}

pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    open(&master_key()?, blob)
}

fn cipher(key: &[u8; KEY_LEN]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("ключ AES-256 має 32 байти"))
}

/// Формат: nonce (12 байт) ‖ шифртекст ‖ тег автентичності (16 байт).
fn seal(key: &[u8; KEY_LEN], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "не вдалося згенерувати nonce".to_string())?;
    let mut buf = data.to_vec();
    cipher(key)
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf)
        .map_err(|_| "не вдалося зашифрувати".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    Ok(out)
}

fn open(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN + AES_256_GCM.tag_len() {
        return Err(DECRYPT_FAILED.into());
    }
    let (nonce, sealed) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| DECRYPT_FAILED.to_string())?;
    let mut buf = sealed.to_vec();
    let plain = cipher(key).open_in_place(nonce, Aad::empty(), &mut buf).map_err(|_| DECRYPT_FAILED.to_string())?;
    Ok(plain.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Тести не звертаються до справжньої в'язки ключів — лише до шифрування.
    const KEY: [u8; KEY_LEN] = [7; KEY_LEN];

    #[test]
    fn round_trip() {
        let secret = "sk-ant-тест-🔑".as_bytes();
        let blob = seal(&KEY, secret).unwrap();
        assert_eq!(blob.len(), NONCE_LEN + secret.len() + AES_256_GCM.tag_len());
        assert_ne!(&blob[NONCE_LEN..NONCE_LEN + secret.len()], secret);
        assert_eq!(open(&KEY, &blob).unwrap(), secret);
    }

    #[test]
    fn nonce_is_random() {
        assert_ne!(seal(&KEY, b"same").unwrap(), seal(&KEY, b"same").unwrap());
    }

    #[test]
    fn rejects_wrong_key_tampering_and_garbage() {
        let blob = seal(&KEY, b"secret").unwrap();
        assert!(open(&[8; KEY_LEN], &blob).is_err());
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open(&KEY, &tampered).is_err());
        assert!(open(&KEY, b"short").is_err());
        assert!(open(&KEY, b"plain-text-key-from-older-version").is_err());
    }
}
