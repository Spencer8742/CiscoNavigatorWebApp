"""The pyatv exception types the bridge has to tell apart.

Every one of these stringifies to '' when raised without an argument, which
is exactly the case the bridge used to turn into a bare "command failed".
"""


class BaseError(Exception):
    pass


class ProtocolError(BaseError):
    pass


class AuthenticationError(BaseError):
    pass


class InvalidCredentialsError(BaseError):
    pass


class NoCredentialsError(BaseError):
    pass


class ConnectionFailedError(BaseError):
    pass


class ConnectionLostError(BaseError):
    pass


class NotSupportedError(BaseError):
    pass


class OperationTimeoutError(BaseError):
    pass


class PairingError(BaseError):
    pass


class HttpError(BaseError):
    def __init__(self, message="", status_code=0):
        super().__init__(message)
        self.status_code = status_code
