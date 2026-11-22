package io.prism.router.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceRouteCodecTest {
    @Test
    fun encodesAndDecodesCanonicalMac() {
        val encoded = DeviceRouteCodec.encode("3c:7c:3f:11:22:01")
        assertEquals("3C%3A7C%3A3F%3A11%3A22%3A01", encoded)
        assertEquals("3C:7C:3F:11:22:01", DeviceRouteCodec.decode(encoded!!))
    }

    @Test
    fun acceptsNavigationDecodedMac() {
        assertEquals("3C:7C:3F:11:22:01", DeviceRouteCodec.decode("3C:7C:3F:11:22:01"))
    }

    @Test
    fun normalizesBareHexAndDashSeparators() {
        assertEquals("3C:7C:3F:11:22:01", DeviceRouteCodec.decode("3c7c3f112201"))
        assertEquals("3C:7C:3F:11:22:01", DeviceRouteCodec.decode("3c-7c-3f-11-22-01"))
    }

    @Test
    fun rejectsMissingInvalidAndAmbiguousValues() {
        assertEquals("", DeviceRouteCodec.decode(""))
        assertEquals("", DeviceRouteCodec.decode("-"))
        assertEquals("", DeviceRouteCodec.decode("not-a-mac"))
        assertEquals("", DeviceRouteCodec.decode("3C%3A7C%3A3F%3A11%3A22%3A0G"))
        assertEquals("", DeviceRouteCodec.decode("%ZZ"))
        assertNull(DeviceRouteCodec.encode("3C%3A7C%3A3F%3A11%3A22%3A01"))
    }
}
