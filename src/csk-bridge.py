"""Use the user's installed Infineon 1.1 API; no vendor code is redistributed.

Only GET_FIRMWARE_INFO and GET_SENSOR_CONFIG are sent. The firmware must already
emit its detection events. No register writes, source switching, or flashing.
"""
import argparse
import contextlib
import json
import os
import sys
import threading
import time
import types

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--vendor-lib', required=True)
parser.add_argument('--port', required=True)
parser.add_argument('--probe-seconds', type=float, default=0)
args = parser.parse_args()
output_lock = threading.Lock()
bridge_output = sys.stdout


def emit(value):
    with output_lock:
        print(json.dumps(value, ensure_ascii=True), file=bridge_output, flush=True)


try:
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError('The installed 1.1 API requires CPython 3.11')
    # The frozen application omits wheel distribution metadata. Load its hardware
    # API as a package namespace, without executing its application entry point.
    sys.path.insert(0, args.vendor_lib)
    namespace = types.ModuleType('ifxapp')
    namespace.__path__ = [os.path.join(args.vendor_lib, 'ifxapp')]
    sys.modules['ifxapp'] = namespace
    with contextlib.redirect_stdout(sys.stderr):
        from ifxapp.hardware_access.transports.serial_transport import SerialTransport
        from ifxapp.hardware_access.event_readers.event_reader import DeviceClient
        from ifxapp.hardware_access.event_readers.protocols.binary_protocol import BinaryProtocol
        from ifxapp.hardware_access.event_readers.protocols.protocol_interface import TerminalCommand, ReceivedMessageType
    serial_transport = SerialTransport()
    protocol = BinaryProtocol()
    lost = threading.Event()
    event_count = 0
    closing = False

    def received(raw):
        global event_count
        now, mono = time.time_ns() / 1_000_000, str(time.perf_counter_ns())
        try:
            message = protocol.decode_message(raw)
            if message.type in (ReceivedMessageType.EVENT, ReceivedMessageType.FRAMES_DROPPED):
                event_count += 1
                emit({'kind': 'event', 'message_utf8': raw, 'decoded_payload': message.payload,
                      'pc_receive_unix_ms': now, 'pc_receive_monotonic_ns': mono,
                      'pc_receive_monotonic_basis': 'bridge_process_perf_counter',
                      'transport': 'csk_uart_installed_vendor_api'})
        except Exception as error:
            emit({'kind': 'event', 'message_utf8': raw, 'pc_receive_unix_ms': now,
                  'pc_receive_monotonic_ns': mono, 'pc_receive_monotonic_basis': 'bridge_process_perf_counter',
                  'transport': 'csk_uart_installed_vendor_api', 'decode_error': str(error)})

    # Compose a transport decorator using the documented callback API. A second
    # direct registration would replace DeviceClient's response callback.
    class CaptureTransport:
        def register_message_received_callback(self, callback):
            def forward(raw):
                received(raw)
                callback(raw)
            serial_transport.register_message_received_callback(forward)
        def register_connection_lost_callback(self, callback):
            serial_transport.register_connection_lost_callback(callback)
        def connect(self, *args, **kwargs):
            serial_transport.connect(*args, **kwargs)
        def disconnect(self, *args, **kwargs):
            serial_transport.disconnect(*args, **kwargs)
        def send(self, raw):
            serial_transport.send(raw)
    client = DeviceClient(CaptureTransport(), protocol)
    def disconnected(error):
        if not closing:
            lost.set()
            emit({'kind': 'error', 'message': str(error or 'UART disconnected')})
    client.register_connection_lost_callback(disconnected)
    with contextlib.redirect_stdout(sys.stderr):
        client.connect(port=args.port, baudrate=2_000_000, timeout=0.2, write_timeout=1.0)

    def query(command):
        done, result = threading.Event(), {}
        def reply(message):
            result['payload'] = message.payload
            result['state'] = getattr(message.state, 'name', str(message.state))
            if message.exception:
                result['error'] = str(message.exception)
            done.set()
        with contextlib.redirect_stdout(sys.stderr):
            client.send_command(command, timeout=2.0, max_attempts=1, callback=reply)
        if not done.wait(3.0):
            return {'error': 'read-only query timeout', 'payload': 'unknown'}
        return result

    firmware = query(TerminalCommand.GET_FIRMWARE_INFO)
    settings = query(TerminalCommand.GET_SENSOR_CONFIG)
    emit({'kind': 'ready', 'firmware': firmware, 'sensor_configuration': settings,
          'driver': 'installed_Visualization_Tool_1.1_API', 'commands': ['GET_FIRMWARE_INFO', 'GET_SENSOR_CONFIG']})
    if args.probe_seconds:
        lost.wait(min(args.probe_seconds, 30))
    else:
        for line in sys.stdin:
            if line.strip() == 'stop':
                break
    closing = True
    with contextlib.redirect_stdout(sys.stderr):
        client.disconnect()
    emit({'kind': 'stopped', 'event_count': event_count})
except Exception as error:
    emit({'kind': 'error', 'message': str(error), 'error_type': type(error).__name__})
    try:
        client.disconnect()
    except Exception:
        pass
    sys.exit(1)
