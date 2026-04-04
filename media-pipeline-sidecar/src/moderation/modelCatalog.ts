export const ModerationModelCatalog = {
  image: [
    {
      name: 'Marqo/nsfw-image-detection-384',
      type: 'classification',
      notes: 'Lightweight, high accuracy (~98% reported)'
    },
    {
      name: 'FalconsAI/nsfw_image_detection',
      type: 'classification',
      notes: 'ViT-based, widely used baseline model'
    },
    {
      name: 'SigLIP2 Guard-Against-Unsafe-Content',
      type: 'classification',
      notes: 'Multi-label modern model with strong accuracy'
    }
  ],
  video: [
    {
      name: 'OpenNSFW2',
      type: 'frame-classification',
      notes: 'Frame-by-frame NSFW probability'
    },
    {
      name: 'NudeNet',
      type: 'object-detection',
      notes: 'Detects explicit body parts in images/videos'
    },
    {
      name: 'SafeVision ONNX models',
      type: 'real-time detection',
      notes: 'Multi-class detection for streams and video'
    }
  ]
} as const;
