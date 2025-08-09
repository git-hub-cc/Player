import os
import json
from mutagen.id3 import ID3, APIC
from mutagen.mp3 import MP3
from mutagen.flac import FLAC # 保留以便未来支持flac格式
from mutagen.easyid3 import EasyID3

# --- 配置 ---
# 根目录，所有路径都基于此
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MUSIC_DIR = os.path.join(BASE_DIR, 'music')
VIDEO_DIR = os.path.join(BASE_DIR, 'videos')
ALBUM_ART_DIR = os.path.join(BASE_DIR, 'albumArt')
PLAYLIST_FILE = os.path.join(BASE_DIR, 'playlist.json')

# --- 音频默认配置 ---
DEFAULT_AUDIO_ARTIST = 'Unknown Artist'
SUPPORTED_AUDIO_EXTS = ('.mp3', '.flac', '.wav', '.m4a')
SUPPORTED_VIDEO_EXTS = ('.mp4', '.mov', '.avi')


def get_audio_metadata(filepath):
    """从音频文件中提取标题和艺术家。"""
    try:
        audio = EasyID3(filepath)
        # 使用 .get() 并提供默认值以避免 KeyError
        # 使用 [0] 或 None 的方式避免 IndexError
        title = audio.get('title', [None])[0]
        artist = audio.get('artist', [None])[0]
        return title, artist
    except Exception as e:
        print(f"  - 无法读取元数据 {os.path.basename(filepath)}: {e}")
        return None, None

def extract_album_art(filepath, filename_base, art_dir):
    """
    从音频文件中提取内置专辑封面，并以音乐文件名命名保存到 art_dir 目录。
    """
    try:
        # 只处理 MP3 文件中的 APIC 帧
        if filepath.lower().endswith('.mp3'):
            audio = MP3(filepath, ID3=ID3)
            # 查找 APIC (Attached Picture) 帧
            for tag in audio.tags.values():
                if isinstance(tag, APIC):
                    art_data = tag.data
                    # 从 MIME 类型获取文件扩展名
                    ext = tag.mime.split('/')[-1]
                    if ext == 'jpeg': ext = 'jpg'

                    # 使用音乐文件名作为封面文件名，确保唯一性和可读性
                    art_filename = f"{filename_base}.{ext}"
                    art_path = os.path.join(art_dir, art_filename)

                    with open(art_path, 'wb') as img_file:
                        img_file.write(art_data)

                    # 返回相对路径并使用正斜杠
                    return os.path.join(os.path.basename(art_dir), art_filename).replace(os.sep, '/')
    except Exception as e:
        print(f"  - 无法提取封面 {os.path.basename(filepath)}: {e}")
    return "" # 如果没有找到封面或出错，返回空字符串

def to_relative_path(base, full_path):
    """将绝对路径转换为相对于 base 的路径，并使用正斜杠。"""
    return os.path.relpath(full_path, base).replace(os.sep, '/')

def main():
    """主函数，生成 playlist.json。"""
    # 确保专辑封面目录存在
    if not os.path.exists(ALBUM_ART_DIR):
        print(f"创建目录: {ALBUM_ART_DIR}")
        os.makedirs(ALBUM_ART_DIR)

    new_playlist = []
    # 用于为没有艺术家标签的音轨生成唯一名称
    unknown_artist_counter = 1

    # --- 1. 递归处理音频文件 ---
    print(f"\n正在从 '{MUSIC_DIR}' 及其子目录中扫描音频文件...")
    if not os.path.exists(MUSIC_DIR):
        print(f"警告: 音乐目录 '{MUSIC_DIR}' 不存在。")
    else:
        # 使用 os.walk() 递归遍历所有子目录
        for root, _, files in os.walk(MUSIC_DIR):
            files.sort()  # 保证处理顺序一致
            for filename in files:
                # 检查是否是支持的音频文件
                if not filename.lower().endswith(SUPPORTED_AUDIO_EXTS):
                    continue

                filepath = os.path.join(root, filename)
                print(f"正在处理: {to_relative_path(BASE_DIR, filepath)}")

                filename_base, _ = os.path.splitext(filename)

                # 提取元数据
                title, artist = get_audio_metadata(filepath)

                # 提取专辑封面
                album_art_path = extract_album_art(filepath, filename_base, ALBUM_ART_DIR)

                # 如果没有从标签中获取到标题，则使用文件名作为标题
                title = title or filename_base

                # 如果没有艺术家，则生成一个默认的
                if not artist:
                    artist = f"{DEFAULT_AUDIO_ARTIST}_{unknown_artist_counter:03d}"
                    unknown_artist_counter += 1

                # --- 核心优化：查找匹配的 .lrc 歌词文件 ---
                lrc_filepath = os.path.join(root, f"{filename_base}.lrc")
                lyrics_path = ""
                if os.path.exists(lrc_filepath):
                    # 获取相对路径，便于前端访问
                    lyrics_path = to_relative_path(BASE_DIR, lrc_filepath)
                    print(f"  - 找到歌词: {lyrics_path}")
                else:
                    print(f"  - 未找到歌词: {filename_base}.lrc")

                track_info = {
                    "type": "audio",
                    "src": to_relative_path(BASE_DIR, filepath),
                    "title": title,
                    "artist": artist,
                    "albumArt": album_art_path, # 封面路径
                    "lyrics": lyrics_path      # 歌词路径
                }
                new_playlist.append(track_info)

    # --- 2. 处理视频文件 (逻辑保持不变，但路径处理更规范) ---
    print(f"\n正在从 '{VIDEO_DIR}' 中扫描视频文件...")
    if not os.path.exists(VIDEO_DIR):
        print(f"警告: 视频目录 '{VIDEO_DIR}' 不存在。")
    else:
        video_files = sorted([f for f in os.listdir(VIDEO_DIR) if f.lower().endswith(SUPPORTED_VIDEO_EXTS)])
        for i, filename in enumerate(video_files, 1):
            filepath = os.path.join(VIDEO_DIR, filename)
            print(f"正在处理: {to_relative_path(BASE_DIR, filepath)}")

            track_info = {
                "type": "video",
                "src": to_relative_path(BASE_DIR, filepath),
                "title": f"Video Title {i:03d}", # 使用更有意义的默认标题
                "artist": f"Video Artist {i:03d}",
                "albumArt": "",  # 视频通常没有专辑封面
                "lyrics": ""
            }
            new_playlist.append(track_info)

    # --- 3. 写入新的 playlist.json ---
    try:
        with open(PLAYLIST_FILE, 'w', encoding='utf-8') as f:
            json.dump(new_playlist, f, indent=2, ensure_ascii=False)
        print(f"\n成功生成 '{PLAYLIST_FILE}', 共包含 {len(new_playlist)} 个条目。")
    except Exception as e:
        print(f"\n错误：无法写入文件 '{PLAYLIST_FILE}': {e}")


if __name__ == '__main__':
    main()