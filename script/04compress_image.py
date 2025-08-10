import os
from PIL import Image
import io

# --- 配置参数 ---
MAX_HEIGHT = 400  # 图片最大高度
MAX_SIZE_KB = 80  # 图片最大体积 (KB)
OUTPUT_DIR = 'compressed_images'  # 输出文件夹名称
JPG_QUALITY = 90 # JPEG 图片初始压缩质量

def process_images():
    """
    处理当前目录下的图片，调整尺寸并压缩。
    """
    # 将 KB 转换为 Bytes
    target_size_bytes = MAX_SIZE_KB * 1024

    # 获取当前目录
    current_dir = os.getcwd()

    # 创建输出目录（如果不存在）
    output_path = os.path.join(current_dir, OUTPUT_DIR)
    if not os.path.exists(output_path):
        os.makedirs(output_path)
        print(f"已创建输出目录: {output_path}")

    # 支持的图片格式
    supported_formats = ('.jpg', '.jpeg', '.png')

    # 遍历当前目录下的所有文件
    for filename in os.listdir(current_dir):
        # 检查文件是否是支持的图片格式
        if filename.lower().endswith(supported_formats):
            try:
                # 构建完整的文件路径
                file_path = os.path.join(current_dir, filename)

                # 获取原始文件大小
                original_size = os.path.getsize(file_path) / 1024
                print(f"\n--- 正在处理: {filename} (原始大小: {original_size:.2f} KB) ---")

                # 打开图片
                img = Image.open(file_path)

                # 转换所有图片为 RGB 模式，以避免保存 PNG 到 JPEG 时出现问题
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')

                # 1. 调整尺寸
                width, height = img.size
                if height > MAX_HEIGHT:
                    # 计算新的宽度以保持比例
                    ratio = MAX_HEIGHT / height
                    new_width = int(width * ratio)
                    img = img.resize((new_width, MAX_HEIGHT), Image.LANCZOS)
                    print(f"尺寸已调整: {img.size[0]}x{img.size[1]}px")
                else:
                    print(f"尺寸无需调整: {width}x{height}px")

                # 2. 压缩文件大小
                # 使用内存流来保存和检查大小，避免反复写入磁盘
                buffer = io.BytesIO()
                current_quality = JPG_QUALITY # 从设定的初始质量开始

                # 循环降低质量直到满足大小要求
                while current_quality > 10:
                    buffer.seek(0) # 重置流的指针
                    buffer.truncate() # 清空流内容

                    # 以当前质量保存图片到内存流
                    img.save(buffer, format='JPEG', quality=current_quality, optimize=True)

                    # 检查内存流中的大小
                    if buffer.tell() <= target_size_bytes:
                        break # 如果大小达标，则跳出循环

                    # 降低质量，继续尝试
                    current_quality -= 5

                # 构建输出文件路径
                output_file_path = os.path.join(output_path, filename)

                # 将最终的压缩图片从内存流写入文件
                with open(output_file_path, 'wb') as f:
                    f.write(buffer.getvalue())

                final_size = os.path.getsize(output_file_path) / 1024
                print(f"处理完成! -> {os.path.basename(output_file_path)} (最终大小: {final_size:.2f} KB, 压缩质量: {current_quality})")

            except Exception as e:
                print(f"处理文件 {filename} 时出错: {e}")

if __name__ == "__main__":
    process_images()
    print("\n所有图片处理完毕！")