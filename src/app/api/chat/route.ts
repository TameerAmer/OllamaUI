import { createOllama } from 'ollama-ai-provider';
import { streamText, convertToCoreMessages, CoreMessage, UserContent } from 'ai';
import AWS from 'aws-sdk';

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Destructure request data
  const { messages, selectedModel, data } = await req.json();

  // Remove experimental_attachments from each message
  const cleanedMessages = messages.map((message: any) => {
    const { experimental_attachments, ...cleanMessage } = message;
    return cleanMessage;
  });

  let message = 'Please provide an image for object detection.';
 
  // Check if there are images for object detection
  if (data?.images && data.images.length > 0) {
    try {

      // Handle object detection for the first image
      const imageUrl = data.images[0];


      // Robust filename extraction: handle data URLs and normal URLs
      let filename = 'image.jpg';
      if (imageUrl.startsWith('data:')) {
        // Data URL: try to extract extension from mime type
        const match = imageUrl.match(/^data:(image\/(png|jpeg|jpg));base64,/);
        let ext = 'jpg';
        if (match) {
          ext = match[2] === 'jpeg' ? 'jpg' : match[2];
        }
        filename = `image_${Date.now()}.${ext}`;
      } else {
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const last = pathParts[pathParts.length - 1];
          if (last && last.includes('.')) {
            filename = last;
          } else {
            filename = `image_${Date.now()}.jpg`;
          }
        } catch (e) {
          // fallback: try to extract from string
          const parts = imageUrl.split('/');
          const last = parts[parts.length - 1];
          if (last && last.includes('.')) {
            filename = last;
          } else {
            filename = `image_${Date.now()}.jpg`;
          }
        }
      }

      // Determine user (if available in data, else anonymous)
      const user = data?.username || 'anonymous';

      // S3 key as <user>/original/<filename>
      const s3Key = `${user}/original/${filename}`;

      // Convert data URL to blob for upload
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Configure AWS SDK (credentials loaded from ~/.aws/credentials)
      const s3 = new AWS.S3({
        region: process.env.AWS_REGION,
      });
      const s3Bucket = process.env.S3_BUCKET;

      // Upload to S3 (no ACL, for Object Ownership enforced buckets)
      const uploadResult = await s3.upload({
        Bucket: s3Bucket!,
        Key: s3Key,
        Body: buffer,
        ContentType: blob.type,
      }).promise();

      const s3Url = uploadResult.Location;
      // Call the object detection API with just the filename
      const predictionResponse = await fetch(`http://${process.env.YOLO_SERVICE}/predict?img=${encodeURIComponent(filename)}`, {
        method: 'POST',
      });

      if (!predictionResponse.ok) {
        throw new Error(`Prediction API error: ${predictionResponse.status}`);
      }

      const predictionResult = await predictionResponse.json();

      // Format the detection results for chat
      message = `🔍 **Object Detection Results**

**Detection Count:** ${predictionResult.detection_count}
**Detected Objects:** ${predictionResult.labels.join(', ')}
**Prediction ID:** ${predictionResult.prediction_uid}
I've analyzed your image and detected ${predictionResult.detection_count} object(s). The detected objects include: ${predictionResult.labels.join(', ')}.`;
    } catch (error) {
      console.log(process.env.YOLO_SERVICE);
      message = `❌ **Object Detection Error**

Sorry, I encountered an error while processing your image: ${error instanceof Error ? error.message : 'Unknown error'}

Please make sure the object detection service is running and S3 is configured correctly.`;
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Split message into lines and send each line as a separate chunk
      const lines = message.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Add newline character back except for the last line
        const content = i < lines.length - 1 ? line + '\n' : line;
        controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
      }
      
      // Send finish event
      controller.enqueue(encoder.encode(`e:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length },
        isContinued: false
      })}\n`));
      
      // Send done event
      controller.enqueue(encoder.encode(`d:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length }
      })}\n`));
      
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}