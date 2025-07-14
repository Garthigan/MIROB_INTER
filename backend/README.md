# Face Detection Backend

This is the Python backend for the face detection and recognition system.

## Setup

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Create a `known_faces` directory in the backend folder and add images of known faces:
- Place images of known faces in the `known_faces` directory
- Name the files as `person_name.jpg` or `person_name.png`
- Each image should contain a clear face of the person

## Running the Server

1. Start the WebSocket server:
```bash
python server.py
```

The server will:
- Load all known faces from the `known_faces` directory
- Start a WebSocket server on `ws://localhost:8000`
- Process incoming video frames and return face detection results

## Face Detection Results

The server returns JSON data in the following format:
```json
{
  "faces": [
    {
      "box": [x, y, width, height],
      "name": "Person Name",
      "confidence": 0.95
    }
  ]
}
```

Where:
- `box`: Face bounding box coordinates [x, y, width, height]
- `name`: Name of the recognized person or "Unknown"
- `confidence`: Confidence score (0-1) of the recognition 