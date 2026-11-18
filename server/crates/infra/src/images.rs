//! 图片的校验和处理。

use std::io::Cursor;

use async_trait::async_trait;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use vibechat_core::account::store::{ImageProcessor, ProcessedImage, Thumbnail};

/// 头像的最长边。
const AVATAR_MAX_SIDE: u32 = 512;
/// 会话里显示的缩略图的最长边。
const THUMBNAIL_MAX_SIDE: u32 = 480;
/// 超过这个尺寸的图片直接拒绝，不去解码：一个很小的文件可以声称自己有巨大的尺寸，
/// 解码时会吃掉大量内存。
const MAX_SOURCE_SIDE: u32 = 8000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
const JPEG_QUALITY: u8 = 85;

pub struct ImageCodec;

#[async_trait]
impl ImageProcessor for ImageCodec {
    async fn process_avatar(&self, content: Vec<u8>) -> Option<ProcessedImage> {
        // 解码和缩放是纯计算，放到专门的线程上，不占用处理请求的线程
        tokio::task::spawn_blocking(move || process_avatar(&content))
            .await
            .ok()
            .flatten()
    }

    async fn thumbnail(&self, content: Vec<u8>) -> Option<Thumbnail> {
        tokio::task::spawn_blocking(move || thumbnail(&content))
            .await
            .ok()
            .flatten()
    }
}

/// 解码一张图片并按照片里记的方向转正。返回图片和它原来的格式。
/// 不是受支持的图片、内容损坏、尺寸超过限制时返回 `None`。
fn decode(content: &[u8]) -> Option<(DynamicImage, ImageFormat)> {
    // 按内容而不是文件名或声明的类型判断格式
    let mut reader = ImageReader::new(Cursor::new(content))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().ok()?;
    // 手机拍的照片常常靠附带信息里的"方向"来表示旋转。重新编码会丢掉这个信息，
    // 所以先把图片本身转正
    let orientation = decoder.orientation().ok()?;
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    Some((image, format))
}

/// 重新编码：输出里只有像素，原文件附带的拍摄地点等信息都不会保留。
/// 带透明的图片存成 PNG，其余存成体积小得多的 JPEG。
fn encode(image: &DynamicImage) -> Option<(Vec<u8>, &'static str)> {
    let mut output = Vec::new();
    if image.color().has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
            .write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
            .ok()?;
        Some((output, "image/png"))
    } else {
        let encoder = JpegEncoder::new_with_quality(&mut output, JPEG_QUALITY);
        image.to_rgb8().write_with_encoder(encoder).ok()?;
        Some((output, "image/jpeg"))
    }
}

fn thumbnail(content: &[u8]) -> Option<Thumbnail> {
    let (image, format) = decode(content)?;
    let original_type = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => return None,
    };
    let (width, height) = (image.width(), image.height());
    // 动图解出来的是第一帧；缩略图不动，点开原图才动
    let small = if width.max(height) > THUMBNAIL_MAX_SIDE {
        image.resize(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, FilterType::Triangle)
    } else {
        image
    };
    let (content, content_type) = encode(&small)?;
    Some(Thumbnail {
        content,
        content_type,
        original_type,
        width,
        height,
    })
}

fn process_avatar(content: &[u8]) -> Option<ProcessedImage> {
    let (mut image, _) = decode(content)?;
    if image.width().max(image.height()) > AVATAR_MAX_SIDE {
        image = image.resize(AVATAR_MAX_SIDE, AVATAR_MAX_SIDE, FilterType::Lanczos3);
    }
    let (output, content_type) = encode(&image)?;

    Some(ProcessedImage {
        content: output,
        content_type,
        width: image.width(),
        height: image.height(),
    })
}

#[cfg(test)]
mod tests {
    use image::{ImageBuffer, Rgb, Rgba};

    use super::*;

    fn encoded(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    fn opaque(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_pixel(width, height, Rgb([200, 80, 40])))
    }

    #[test]
    fn a_small_photo_keeps_its_size_and_becomes_jpeg() {
        let out = process_avatar(&encoded(opaque(100, 60), ImageFormat::Png)).unwrap();
        assert_eq!((out.width, out.height), (100, 60));
        assert_eq!(out.content_type, "image/jpeg");
        assert_eq!(
            image::guess_format(&out.content).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn a_large_photo_is_scaled_down_keeping_its_shape() {
        let out = process_avatar(&encoded(opaque(2000, 1000), ImageFormat::Jpeg)).unwrap();
        assert_eq!((out.width, out.height), (512, 256));
    }

    #[test]
    fn an_image_with_transparency_stays_png() {
        let transparent =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(40, 40, Rgba([10, 20, 30, 128])));
        let out = process_avatar(&encoded(transparent, ImageFormat::Png)).unwrap();
        assert_eq!(out.content_type, "image/png");
        assert_eq!(image::guess_format(&out.content).unwrap(), ImageFormat::Png);
    }

    #[test]
    fn content_that_is_not_an_image_is_refused() {
        assert!(process_avatar(b"#!/bin/sh\necho hi").is_none());
        assert!(process_avatar(b"").is_none());
        assert!(process_avatar(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
    }

    #[test]
    fn a_truncated_image_is_refused() {
        let bytes = encoded(opaque(100, 100), ImageFormat::Png);
        assert!(process_avatar(&bytes[..bytes.len() / 2]).is_none());
    }

    #[test]
    fn an_image_claiming_enormous_dimensions_is_refused() {
        let bytes = encoded(opaque(MAX_SOURCE_SIDE + 1, 1), ImageFormat::Png);
        assert!(process_avatar(&bytes).is_none());
    }

    #[test]
    fn a_thumbnail_is_small_and_remembers_the_original_size_and_type() {
        let out = thumbnail(&encoded(opaque(1600, 800), ImageFormat::Png)).unwrap();
        assert_eq!((out.width, out.height), (1600, 800));
        assert_eq!(out.original_type, "image/png");
        assert_eq!(out.content_type, "image/jpeg");
        let small = image::load_from_memory(&out.content).unwrap();
        assert_eq!((small.width(), small.height()), (480, 240));

        // 本来就小的图片不放大
        let out = thumbnail(&encoded(opaque(100, 60), ImageFormat::Jpeg)).unwrap();
        assert_eq!(out.original_type, "image/jpeg");
        let small = image::load_from_memory(&out.content).unwrap();
        assert_eq!((small.width(), small.height()), (100, 60));
    }

    #[test]
    fn a_gif_or_webp_also_gets_a_thumbnail() {
        let out = thumbnail(&encoded(opaque(20, 10), ImageFormat::Gif)).unwrap();
        assert_eq!(out.original_type, "image/gif");
        let out = thumbnail(&encoded(opaque(20, 10), ImageFormat::WebP)).unwrap();
        assert_eq!(out.original_type, "image/webp");
    }

    #[test]
    fn only_real_images_get_a_thumbnail() {
        assert!(thumbnail(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        assert!(thumbnail(b"\x89PNG\r\n\x1a\nnot really").is_none());
        let huge = encoded(opaque(MAX_SOURCE_SIDE + 1, 1), ImageFormat::Png);
        assert!(thumbnail(&huge).is_none());
    }
}
