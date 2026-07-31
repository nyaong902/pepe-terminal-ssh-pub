"""
카카오톡 이모티콘 GIF의 배경을 투명화 — 애니메이션(모든 프레임) 유지.

라인아트 캐릭터는 배경색과 피부색이 거의 동일(둘 다 흰색)해서 단순 색상 기반
flood-fill 로는 배경만 골라낼 수 없다(캐릭터 얼굴 안쪽까지 지워짐). 대신 rembg
(u2net, 사람/사물 세그멘테이션 AI 모델)로 프레임마다 전경을 분리한 뒤:
  1. 알파를 하드 threshold 로 이분화 — u2net 출력에 남는 옅은 잔여물(텍스트 등) 제거
  2. 가장 큰 연결 영역만 남김 — 분리된 작은 잡음 덩어리 제거
"""
from pathlib import Path
from PIL import Image, ImageSequence
import numpy as np
from scipy import ndimage
from rembg import remove, new_session

SRC_DIR = Path(r"C:\Users\shdfr\Downloads\pepe-local-package\messenger-emoticons\kakao-talk-pack")
OUT_DIR = SRC_DIR / "transparent"
ALPHA_THRESHOLD = 100

_session = None


def get_session():
    global _session
    if _session is None:
        _session = new_session("u2net")
    return _session


def clean_alpha(rgba_arr: np.ndarray) -> np.ndarray:
    alpha = rgba_arr[:, :, 3].astype(np.int32)
    mask = alpha >= ALPHA_THRESHOLD
    labeled, n = ndimage.label(mask)
    if n == 0:
        rgba_arr[:, :, 3] = 0
        return rgba_arr
    sizes = ndimage.sum(mask, labeled, range(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    keep = labeled == biggest
    rgba_arr[:, :, 3] = np.where(keep, 255, 0).astype(np.uint8)
    return rgba_arr


def process_gif(src_path: Path, out_path: Path):
    im = Image.open(src_path)
    session = get_session()
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(im):
        rgba = frame.convert("RGBA")
        removed = remove(rgba, session=session)
        arr = np.array(removed)
        arr = clean_alpha(arr)
        frames.append(Image.fromarray(arr, "RGBA"))
        durations.append(frame.info.get("duration", 100))
    loop = im.info.get("loop", 0)
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=loop,
        disposal=2,
        transparency=0,
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    gifs = sorted(SRC_DIR.glob("*.gif"))
    if not gifs:
        print("no gif files found")
        return
    for gif in gifs:
        out_path = OUT_DIR / gif.name
        print(f"processing {gif.name} ...")
        try:
            process_gif(gif, out_path)
        except Exception as e:
            print(f"  FAILED: {e}")
    print(f"done. output: {OUT_DIR}")


if __name__ == "__main__":
    main()
